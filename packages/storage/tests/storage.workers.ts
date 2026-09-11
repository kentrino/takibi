import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { BadRequestError } from "@takibi/api";
import { expect, test } from "vite-plus/test";
import {
  compileIndexRegistry,
  compileIndexedScanSql,
  createDurableObjectStorage,
  physicalIndexName,
  reconcileCollectionIndexes,
  resolveIndexedList,
  type StoredDocument,
} from "../src";
import type { QueryExpr, WithMetadata } from "@takibi/shared-types";
import { expectedStorageContractObservation, observeStorageContract } from "./storage-contract";
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

function decodeCursor(token: string): Record<string, unknown> {
  const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function encodeCursor(cursor: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function tableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'takibi_%'
       ORDER BY name`,
    )
    .toArray()
    .map(({ name }) => name);
}

test("Workers Durable Object SQLite satisfies the shared storage contract", async () => {
  const stub = storageStub("shared-storage-contract");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const storage = createDurableObjectStorage(state.storage);
    await expect(observeStorageContract(storage)).resolves.toEqual(
      expectedStorageContractObservation,
    );
  });
});

test("actual SQLite-backed DO satisfies query contracts and stores no document KV entries", async () => {
  const stub = storageStub("query-contract");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
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
      await sqlite.put("posts", document);
    }

    await expect(sqlite.get("posts", "a")).resolves.toEqual(documents[0]);

    const cases: Array<{ where: QueryExpr; ids: string[] }> = [
      { where: { field: "owner", op: "eq", value: "u1" }, ids: ["a", "c", "d"] },
      { where: { field: "score", op: "eq", value: 20 }, ids: ["b"] },
      { where: { field: "score", op: "gt", value: 15 }, ids: ["b", "d"] },
      { where: { field: "score", op: "gte", value: 20 }, ids: ["b", "d"] },
      { where: { field: "score", op: "lt", value: 20 }, ids: ["a"] },
      { where: { field: "score", op: "lte", value: 20 }, ids: ["a", "b"] },
      { where: { field: "score", op: "eq", value: "20" }, ids: ["c"] },
      { where: { field: "active", op: "eq", value: true }, ids: ["a", "c"] },
      { where: { field: "nullable", op: "eq", value: null }, ids: ["a"] },
      { where: { field: 'quote".dot[0]', op: "eq", value: "matched" }, ids: ["a"] },
      { where: { field: "attack", op: "eq", value: "' OR 1=1 --" }, ids: ["a"] },
      { where: { field: "unicode", op: "lt", value: "\uE000" }, ids: ["a"] },
      { where: { field: "owner", op: "in", values: ["u1", "u3"] }, ids: ["a", "c", "d"] },
      {
        where: { op: "not", operand: { field: "owner", op: "in", values: ["u2"] } },
        ids: ["a", "c", "d"],
      },
      { where: { field: "owner", op: "contains", value: "u" }, ids: ["a", "b", "c", "d"] },
      { where: { field: "owner", op: "startsWith", value: "u1" }, ids: ["a", "c", "d"] },
      { where: { field: "owner", op: "endsWith", value: "" }, ids: ["a", "b", "c", "d"] },
      { where: { field: "score", op: "contains", value: "" }, ids: ["c"] },
      { where: { field: "nullable", op: "startsWith", value: "" }, ids: ["c"] },
      { where: { field: "missing", op: "endsWith", value: "" }, ids: [] },
      { where: { field: "missing", op: "eq", value: "anything" }, ids: [] },
      {
        where: {
          op: "not",
          operand: { field: "missing", op: "eq", value: "anything" },
        },
        ids: ["a", "b", "c", "d"],
      },
      { where: { field: "nullable", op: "present" }, ids: ["a", "c"] },
      {
        where: { op: "not", operand: { field: "nullable", op: "present" } },
        ids: ["b", "d"],
      },
      { where: { field: "nested", op: "present" }, ids: ["a"] },
      {
        where: {
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
        ids: ["a", "d"],
      },
      { where: { field: "id", op: "gte", value: "c" }, ids: ["c", "d"] },
      { where: { field: "createdAt", op: "eq", value: TS }, ids: ["a", "b", "c", "d"] },
      { where: { field: "createdAt", op: "eq", value: null }, ids: [] },
    ];

    for (const { where, ids } of cases) {
      const first = await sqlite.list("posts", { where, limit: 2 });
      expect(first.items.map(({ id }) => id)).toEqual(ids.slice(0, 2));
      if (ids.length > 2) {
        expect(first.nextCursor).toBeDefined();
        const second = await sqlite.list("posts", {
          where,
          limit: 2,
          cursor: first.nextCursor,
        });
        expect(second.items.map(({ id }) => id)).toEqual(ids.slice(2));
        expect(second.nextCursor).toBeUndefined();
      } else {
        expect(first.nextCursor).toBeUndefined();
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

test("layout initialization is idempotent, rejects a newer layout, and omits maintenance tables", async () => {
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
    ).toBe(4);
    expect(tableNames(state.storage.sql)).toEqual([
      "takibi_documents",
      "takibi_index_catalog",
      "takibi_metadata",
    ]);

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
    expect(tableNames(state.storage.sql)).toEqual([
      "takibi_documents",
      "takibi_index_catalog",
      "takibi_metadata",
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
      const document = {
        id: `p${index}`,
        title: String(revision),
        createdAt: TS,
        updatedAt: TS,
        rev: revision,
      } as StoredDocument;
      await storage.put("posts", document);
      await expect(storage.get("posts", `p${index}`)).resolves.toEqual(document);
    }
  });
});

test("indexed list pages by createdAt and id in both directions", async () => {
  const stub = storageStub("indexed-list");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const registry = compileIndexRegistry({
      posts: { indexes: { byOwner: ["ownerId", "createdAt"] as const } },
    });
    const durable = createDurableObjectStorage(state.storage, registry);
    const docs = [
      { ...meta({ id: "c", ownerId: "u1", tag: "keep" }), createdAt: "2026-01-01T00:00:00.000Z" },
      { ...meta({ id: "a", ownerId: "u1", tag: "skip" }), createdAt: "2026-01-01T00:00:00.000Z" },
      { ...meta({ id: "b", ownerId: "u1", tag: "keep" }), createdAt: "2026-01-02T00:00:00.000Z" },
      { ...meta({ id: "d", ownerId: "u2", tag: "keep" }), createdAt: "2026-01-03T00:00:00.000Z" },
      { ...meta({ id: "e", ownerId: "u1", tag: "keep" }), createdAt: "2026-01-00T00:00:00.000Z" },
    ];
    for (const doc of docs) {
      await durable.put("posts", doc);
    }

    const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
    const desc = {
      index: "byOwner",
      where,
      orderBy: { field: "createdAt", direction: "desc" as const },
      limit: 2,
    };
    const first = await durable.list("posts", desc);
    expect(first.items.map((document) => document.id)).toEqual(["b", "c"]);
    expect(decodeCursor(first.nextCursor!)).toMatchObject({
      v: 3,
      index: "byOwner",
      orderField: "createdAt",
      direction: "desc",
      id: "c",
    });

    const second = await durable.list("posts", { ...desc, cursor: first.nextCursor });
    expect(second.items.map((document) => document.id)).toEqual(["a", "e"]);

    expect(
      (
        await durable.list("posts", {
          index: "byOwner",
          where,
          orderBy: { field: "createdAt", direction: "asc" },
          limit: 10,
        })
      ).items.map((document) => document.id),
    ).toEqual(["e", "a", "c", "b"]);

    await expect(
      durable.list("posts", {
        ...desc,
        where: { field: "ownerId", op: "eq", value: "u2" },
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      durable.list("posts", { orderBy: { field: "createdAt", direction: "desc" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(durable.list("posts", { index: "missing", where })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(durable.list("posts", { cursor: "b" })).rejects.toBeInstanceOf(BadRequestError);

    const missingCursor = encodeCursor({
      ...decodeCursor(first.nextCursor!),
      id: "a0",
    });
    await expect(durable.list("posts", { ...desc, cursor: missingCursor })).resolves.toBeDefined();
  });
});

test("SQLite query plan uses the declared expression index and reconcile drops renamed indexes", async () => {
  const stub = storageStub("index-reconcile");
  await stub.ping();

  await runInDurableObject(stub, async (_instance, state) => {
    const first = {
      posts: { indexes: { byOwner: ["ownerId", "createdAt"] as const } },
    };
    const firstRegistry = compileIndexRegistry(first);
    const durable = createDurableObjectStorage(state.storage, firstRegistry);
    let optimizeCount = 0;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    state.storage.sql.exec = ((query: string, ...bindings: never[]) => {
      if (query === "PRAGMA optimize") optimizeCount += 1;
      return exec(query, ...bindings);
    }) as DurableObjectStorage["sql"]["exec"];

    await reconcileCollectionIndexes({
      sql: state.storage.sql,
      collections: first,
      storage: durable,
      registry: firstRegistry,
    });
    expect(optimizeCount).toBe(1);
    await reconcileCollectionIndexes({
      sql: state.storage.sql,
      collections: first,
      storage: durable,
      registry: firstRegistry,
    });
    expect(optimizeCount).toBe(1);

    await durable.put(
      "posts",
      meta({
        id: "p1",
        ownerId: "u1",
        createdAt: "2026-01-02T00:00:00.000Z",
        score: 2,
        label: "a",
      }),
    );
    const scan = resolveIndexedList(
      "posts",
      {
        index: "byOwner",
        where: { field: "ownerId", op: "eq", value: "u1" },
        orderBy: { field: "createdAt", direction: "desc" },
      },
      firstRegistry,
    );
    const compiled = compileIndexedScanSql("posts", scan!, { limit: 20 });
    const plan = state.storage.sql
      .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${compiled.sql}`, ...compiled.bindings)
      .toArray()
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain(physicalIndexName("posts", "byOwner", ["ownerId", "createdAt"]));

    const renamed = {
      posts: { indexes: { byCreator: ["ownerId", "createdAt"] as const } },
    };
    await reconcileCollectionIndexes({
      sql: state.storage.sql,
      collections: renamed,
      storage: durable,
      registry: compileIndexRegistry(renamed),
    });
    expect(optimizeCount).toBe(2);
    const names = state.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%'`,
      )
      .toArray()
      .map((row) => row.name);
    expect(names).toEqual([physicalIndexName("posts", "byCreator", ["ownerId", "createdAt"])]);
  });
});
