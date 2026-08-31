import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createMigratingStorage } from "../src/migrations";
import { fullAccess } from "../src/policy";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import type { QueryExpr, WithMetadata } from "../src/types";
import type { StorageTestObject } from "./worker";

const TS = "2026-08-19T00:00:00.000Z";

function meta<T extends Record<string, unknown>>(
  document: {
    id: string;
  } & T,
): WithMetadata<T> {
  return { ...document, createdAt: TS, updatedAt: TS, rev: 1 };
}

function storageStub(name: string): DurableObjectStub<StorageTestObject> {
  return env.TAKIBI_STORAGE_TEST.getByName(name);
}

test("actual SQLite-backed DO matches memory query semantics and stores no document KV entries", async () => {
  const stub = storageStub("query-contract");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const memory = createMemoryStorage();
    const sqlite = createDurableObjectStorage(state.storage);
    const documents = [
      meta({
        id: "a",
        owner: "u1",
        score: 10,
        active: true,
        nullable: null,
        'quote".dot[0]': "matched",
        attack: "' OR 1=1 --",
        unicode: "😀",
        nested: { values: [1, true, null, { label: "deep" }] },
      }),
      meta({ id: "b", owner: "u2", score: 20, active: false, unicode: "\uE000" }),
      meta({ id: "c", owner: "u1", score: "20", active: true, nullable: "not-null" }),
      meta({ id: "d", owner: "u1", score: 30, active: false }),
    ];
    for (const document of documents) {
      await memory.put("posts", document);
      await sqlite.put("posts", document);
    }

    await expect(sqlite.get("posts", "a")).resolves.toEqual(documents[0]);

    const queries: QueryExpr[] = [
      { field: "owner", op: "eq", value: "u1" },
      { field: "score", op: "eq", value: 20 },
      { field: "score", op: "gt", value: 15 },
      { field: "score", op: "gte", value: 20 },
      { field: "score", op: "lt", value: 20 },
      { field: "score", op: "lte", value: 20 },
      { field: "score", op: "eq", value: "20" },
      { field: "active", op: "eq", value: true },
      { field: "nullable", op: "eq", value: null },
      { field: 'quote".dot[0]', op: "eq", value: "matched" },
      { field: "attack", op: "eq", value: "' OR 1=1 --" },
      { field: "unicode", op: "lt", value: "\uE000" },
      { field: "missing", op: "eq", value: "anything" },
      { op: "not", operand: { field: "missing", op: "eq", value: "anything" } },
      { field: "nullable", op: "present" },
      { op: "not", operand: { field: "nullable", op: "present" } },
      { field: "nested", op: "present" },
      {
        op: "and",
        operands: [
          { field: "owner", op: "eq", value: "u1" },
          {
            op: "or",
            operands: [
              { field: "score", op: "gte", value: 30 },
              { field: "nullable", op: "eq", value: null },
            ],
          },
        ],
      },
      { field: "id", op: "gte", value: "c" },
      { field: "createdAt", op: "eq", value: TS },
      { field: "createdAt", op: "eq", value: null },
    ];

    for (const where of queries) {
      const expected = await memory.list("posts", { where, limit: 2 });
      const actual = await sqlite.list("posts", { where, limit: 2 });
      expect(actual).toEqual(expected);
      if (actual.nextCursor !== undefined) {
        await expect(
          sqlite.list("posts", { where, limit: 2, cursor: actual.nextCursor }),
        ).resolves.toEqual(
          await memory.list("posts", {
            where,
            limit: 2,
            cursor: expected.nextCursor,
          }),
        );
      }
    }

    const rows = state.storage.sql
      .exec<{ collection: string; count: number }>(
        `SELECT collection, count(*) AS count
         FROM takibi_documents
         GROUP BY collection`,
      )
      .toArray();
    expect(rows).toEqual([{ collection: "posts", count: 4 }]);
    expect(
      state.storage.sql
        .exec<{ revision: number; json_revision_type: string | null }>(
          `SELECT revision, json_type(data, '$.rev') AS json_revision_type
           FROM takibi_documents
           WHERE collection = ? AND id = ?`,
          "posts",
          "a",
        )
        .one(),
    ).toEqual({ revision: 1, json_revision_type: null });
    await expect(state.storage.list({ prefix: "takibi:" })).resolves.toEqual(new Map());

    await sqlite.put("posts", meta({ id: "a", title: "replaced" }));
    await expect(sqlite.get("posts", "a")).resolves.toEqual(meta({ id: "a", title: "replaced" }));
    await expect(sqlite.delete("posts", "a")).resolves.toBe(true);
    await expect(sqlite.delete("posts", "a")).resolves.toBe(false);
    await expect(sqlite.get("posts", "a")).resolves.toBeNull();
  });
});

test("layout initialization is idempotent and rejects a newer layout", async () => {
  const stub = storageStub("layout-version");
  await stub.ping();

  await runInDurableObject(stub, (_instance, state) => {
    createDurableObjectStorage(state.storage);
    createDurableObjectStorage(state.storage);
    expect(
      state.storage.sql
        .exec<{ value: number }>(
          "SELECT value FROM takibi_metadata WHERE key = ?",
          "layout_version",
        )
        .one().value,
    ).toBe(3);

    state.storage.sql.exec(
      "UPDATE takibi_metadata SET value = ? WHERE key = ?",
      999,
      "layout_version",
    );
    expect(() => createDurableObjectStorage(state.storage)).toThrow(
      /Unsupported Takibi storage layout version/,
    );
  });
});

test("SQL pushdown includes stale rows and filters them after lazy migration", async () => {
  const stub = storageStub("lazy-migration");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const raw = createDurableObjectStorage(state.storage);
    await raw.put("posts", meta({ id: "a", title: "MATCH", visible: true }));
    await raw.put("posts", meta({ id: "b", title: "OTHER", visible: false }));
    const storage = createMigratingStorage(
      {
        posts: {
          schema: z.object({ slug: z.string(), published: z.boolean() }),
          migrations: {
            steps: [
              (data) => ({
                slug: (data as { title: string }).title.toLowerCase(),
                published: (data as { visible: boolean }).visible,
              }),
            ],
          },
          accessPolicy: fullAccess,
        },
      },
      raw,
    );

    await expect(
      storage.list("posts", {
        where: { field: "slug", op: "eq", value: "match" },
      }),
    ).resolves.toMatchObject({
      items: [{ id: "a", slug: "match", published: true }],
    });
    await expect(raw.get("posts", "b")).resolves.toMatchObject({
      slug: "other",
      published: false,
      $schemaVersion: 1,
    });
  });
});

test("documents survive Durable Object eviction", async () => {
  const stub = storageStub("eviction");
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const storage = createDurableObjectStorage(state.storage);
    await storage.put("posts", {
      ...meta({ id: "persistent", title: "still here" }),
      rev: 2 ** 63,
    });
  });

  await evictDurableObject(stub);
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const storage = createDurableObjectStorage(state.storage);
    await expect(storage.get("posts", "persistent")).resolves.toEqual({
      ...meta({ id: "persistent", title: "still here" }),
      rev: 2 ** 63,
    });
  });
});

test("version 1 rows migrate revisions out of JSON and survive eviction", async () => {
  const stub = storageStub("revision-layout-migration");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TABLE takibi_metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
    state.storage.sql.exec(
      "INSERT INTO takibi_metadata (key, value) VALUES (?, ?)",
      "layout_version",
      1,
    );
    state.storage.sql.exec(
      `CREATE TABLE takibi_documents (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
        PRIMARY KEY (collection, id)
      ) WITHOUT ROWID`,
    );
    for (const [id, data] of [
      ["valid", { title: "valid", rev: 2 ** 63 }],
      ["missing", { title: "missing" }],
      ["invalid", { title: "invalid", rev: 1.5 }],
    ] as const) {
      state.storage.sql.exec(
        `INSERT INTO takibi_documents
          (collection, id, created_at, updated_at, schema_version, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "posts",
        id,
        TS,
        TS,
        0,
        JSON.stringify(data),
      );
    }

    const storage = createDurableObjectStorage(state.storage);
    await expect(storage.get("posts", "valid")).resolves.toMatchObject({
      title: "valid",
      rev: 2 ** 63,
    });
    expect(
      state.storage.sql
        .exec<{ id: string; revision: number; json_revision_type: string | null }>(
          `SELECT id, revision, json_type(data, '$.rev') AS json_revision_type
           FROM takibi_documents
           ORDER BY id`,
        )
        .toArray(),
    ).toEqual([
      { id: "invalid", revision: 1, json_revision_type: null },
      { id: "missing", revision: 1, json_revision_type: null },
      { id: "valid", revision: 2 ** 63, json_revision_type: null },
    ]);
  });

  await evictDurableObject(stub);
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const storage = createDurableObjectStorage(state.storage);
    await expect(storage.get("posts", "valid")).resolves.toMatchObject({
      title: "valid",
      rev: 2 ** 63,
    });
  });
});

test("Workers SQLite round-trips revisions across numeric storage boundaries", async () => {
  const stub = storageStub("revision-number-boundaries");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const storage = createDurableObjectStorage(state.storage);
    const revisions = [1, 2 ** 53, 2 ** 63];
    for (const [index, revision] of revisions.entries()) {
      await storage.put("posts", {
        id: `p${index}`,
        title: String(revision),
        createdAt: TS,
        updatedAt: TS,
        rev: revision,
      });
      await expect(storage.get("posts", `p${index}`)).resolves.toMatchObject({
        rev: revision,
      });
    }
  });
});
