import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import { openSqliteStorage } from "../src/storage";
import { createNodeSqliteExecutor, type NodeSqliteExecutor } from "@takibi/testing/sqlite-storage";
import type { SqlConnection } from "@takibi/storage";
import { all, one, onStatement } from "./helpers/node-sql";
import type { QueryExpr, StoredDocument, WithMetadata } from "../src/types";
import { generateUlid, isUlid, resetUlidStateForTests } from "../src/ulid";
import {
  expectedStorageContractObservation,
  observeStorageContract,
} from "@takibi/sql-conformance";

const TS = "2026-08-09T14:12:00.000Z";

function meta<T extends Record<string, unknown>>(doc: { id: string } & T): WithMetadata<T> {
  return { ...doc, createdAt: TS, updatedAt: TS, rev: 1 };
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

async function createVersionOneDatabase(
  rows: Array<{
    id: string;
    data: Record<string, unknown>;
  }>,
  intercept?: (connection: SqlConnection) => SqlConnection,
): Promise<NodeSqliteExecutor> {
  const sql = createNodeSqliteExecutor(intercept);
  await sql.transaction(async (tx) => {
    await tx.exec(
      `CREATE TABLE takibi_metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
    await tx.exec("INSERT INTO takibi_metadata (key, value) VALUES (?, ?)", "layout_version", 1);
    await tx.exec(
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
    for (const row of rows) {
      await tx.exec(
        `INSERT INTO takibi_documents
          (collection, id, created_at, updated_at, schema_version, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        "posts",
        row.id,
        TS,
        TS,
        0,
        JSON.stringify(row.data),
      );
    }
  });
  return sql;
}

const takibiTables = async (sql: NodeSqliteExecutor) =>
  (
    await all<{ name: string }>(
      sql,
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'takibi_%'
       ORDER BY name`,
    )
  ).map(({ name }) => name);

test("Node SQLite satisfies the shared storage contract", async () => {
  const storage = (await openSqliteStorage(createNodeSqliteExecutor())).storage;
  await expect(observeStorageContract(storage)).resolves.toEqual(
    expectedStorageContractObservation,
  );
});

test("generateUlid produces valid 26-char Crockford Base32", () => {
  resetUlidStateForTests();
  const id = generateUlid();
  expect(id).toHaveLength(26);
  expect(isUlid(id)).toBe(true);
});

test("monotonic ULID: same-ms generation order matches lexicographic order", () => {
  resetUlidStateForTests();
  const now = 1_700_000_000_000;
  const ids = Array.from({ length: 64 }, () => generateUlid(now));
  for (const id of ids) expect(isUlid(id)).toBe(true);
  const sorted = [...ids].sort();
  expect(sorted).toEqual(ids);
});

test("SQLite pagination preserves order, boundary, and nextCursor", async () => {
  const durable = (await openSqliteStorage(createNodeSqliteExecutor())).storage;

  const docs = [
    meta({ id: "c", title: "C" }),
    meta({ id: "a", title: "A" }),
    meta({ id: "b", title: "B" }),
    meta({ id: "d", title: "D" }),
    meta({ id: "e", title: "E" }),
  ];

  for (const doc of docs) {
    await durable.put("posts", doc);
  }

  // Distinct resources with the same id must not collide on DO keys.
  await durable.put("comments", meta({ id: "a", body: "x" }));
  expect(await durable.get("posts", "a")).toEqual(meta({ id: "a", title: "A" }));
  expect(await durable.get("comments", "a")).toEqual(meta({ id: "a", body: "x" }));

  const page1 = await durable.list("posts", { limit: 2 });
  expect(page1.items.map((d) => d.id)).toEqual(["a", "b"]);
  expect(decodeCursor(page1.nextCursor!)).toEqual({
    v: 4,
    collection: "posts",
    requestedWhere: null,
    binding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    id: "b",
  });

  const page2 = await durable.list("posts", { limit: 2, cursor: page1.nextCursor });
  expect(page2.items.map((d) => d.id)).toEqual(["c", "d"]);
  expect(decodeCursor(page2.nextCursor!)).toMatchObject({ id: "d" });

  const page3 = await durable.list("posts", { limit: 2, cursor: page2.nextCursor });
  expect(page3.items.map((d) => d.id)).toEqual(["e"]);
  expect(page3.nextCursor).toBeUndefined();

  // Missing cursor seeks past that key (startAfter), not rewind to the start.
  const missingCursor = encodeCursor({
    ...decodeCursor(page1.nextCursor!),
    id: "a0",
  });
  const afterMissing = await durable.list("posts", { limit: 10, cursor: missingCursor });
  expect(afterMissing.items.map((d) => d.id)).toEqual(["b", "c", "d", "e"]);

  await expect(durable.list("posts", { cursor: "b" })).rejects.toBeInstanceOf(BadRequestError);
});

test("SQLite filters before limit with query-bound cursors", async () => {
  const durable = (await openSqliteStorage(createNodeSqliteExecutor())).storage;
  const docs = [
    meta({ id: "a", ownerId: "u2", score: 30 }),
    meta({ id: "b", ownerId: "u1", score: 10 }),
    meta({ id: "c", ownerId: "u2", score: 20 }),
    meta({ id: "d", ownerId: "u1", score: 20 }),
    meta({ id: "e", ownerId: "u1", score: 30 }),
  ];
  for (const doc of docs) {
    await durable.put("posts", doc);
  }

  const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
  const first = await durable.list("posts", { limit: 2, where });
  expect(first.items.map((document) => document.id)).toEqual(["b", "d"]);
  expect(decodeCursor(first.nextCursor!)).toEqual({
    v: 4,
    collection: "posts",
    requestedWhere: where,
    binding: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    id: "d",
  });

  const second = await durable.list("posts", {
    limit: 2,
    where,
    cursor: first.nextCursor,
  });
  expect(second.items.map((document) => document.id)).toEqual(["e"]);

  await expect(
    durable.list("comments", { where, cursor: first.nextCursor }),
  ).rejects.toBeInstanceOf(BadRequestError);
  await expect(
    durable.list("posts", {
      where: { field: "ownerId", op: "eq", value: "u2" },
      cursor: first.nextCursor,
    }),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("SQLite supports in and case-sensitive string matching", async () => {
  const durable = (await openSqliteStorage(createNodeSqliteExecutor())).storage;
  const documents = [
    meta({ id: "a", value: "YR Clinic" }),
    meta({ id: "b", value: "yr clinic" }),
    meta({ id: "c", value: null }),
    meta({ id: "d", value: 1 }),
    meta({ id: "e" }),
  ];
  for (const document of documents) {
    await durable.put("items", document);
  }

  const cases: Array<{ where: QueryExpr; ids: string[] }> = [
    { where: { field: "value", op: "in", values: ["YR Clinic", null] }, ids: ["a", "c"] },
    {
      where: { op: "not", operand: { field: "value", op: "in", values: ["yr clinic"] } },
      ids: ["a", "c", "d", "e"],
    },
    { where: { field: "value", op: "contains", value: "Clinic" }, ids: ["a"] },
    { where: { field: "value", op: "startsWith", value: "YR" }, ids: ["a"] },
    { where: { field: "value", op: "endsWith", value: "" }, ids: ["a", "b"] },
  ];
  for (const { where, ids } of cases) {
    const page = await durable.list("items", { where });
    expect(page.items.map((document) => document.id)).toEqual(ids);
  }
});

test("DO SQLite list finds sparse matches across internal chunks", async () => {
  const durable = (await openSqliteStorage(createNodeSqliteExecutor())).storage;

  for (let index = 0; index < 300; index += 1) {
    const id = index.toString().padStart(3, "0");
    await durable.put("posts", meta({ id, selected: index === 0 || index === 128 }));
  }

  const page = await durable.list("posts", {
    limit: 1,
    where: { field: "selected", op: "eq", value: true },
  });

  expect(page.items.map((document) => document.id)).toEqual(["000"]);
  expect(page.nextCursor).toBeDefined();
});

test("DO SQLite get isolates collections sharing the same id", async () => {
  const durable = (await openSqliteStorage(createNodeSqliteExecutor())).storage;
  await durable.put("posts", meta({ id: "p1", title: "hi" }));
  await durable.put("comments", meta({ id: "p1", title: "other" }));

  expect(await durable.get("posts", "p1")).toEqual(meta({ id: "p1", title: "hi" }));
  expect(await durable.get("comments", "p1")).toEqual(meta({ id: "p1", title: "other" }));
  expect(await durable.get("posts", "missing")).toBeNull();
});

test("SQLite layout stores revision in a dedicated REAL column", async () => {
  const sql = createNodeSqliteExecutor();
  const durable = (await openSqliteStorage(sql)).storage;
  const document = { ...meta({ id: "p1", title: "one" }), rev: 7 };

  await durable.put("posts", document);

  expect(
    (
      await one<{ value: number }>(
        sql,
        "SELECT value FROM takibi_metadata WHERE key = ?",
        "layout_version",
      )
    ).value,
  ).toBe(4);
  expect(
    await one<{ name: string; type: string; notnull: number }>(
      sql,
      `SELECT name, type, "notnull"
       FROM pragma_table_info('takibi_documents')
       WHERE name = 'revision'`,
    ),
  ).toEqual({ name: "revision", type: "REAL", notnull: 1 });
  expect(
    await one<{ revision: number; json_revision_type: string | null }>(
      sql,
      `SELECT revision, json_type(data, '$.rev') AS json_revision_type
       FROM takibi_documents
       WHERE collection = ? AND id = ?`,
      "posts",
      "p1",
    ),
  ).toEqual({ revision: 7, json_revision_type: null });
  await expect(durable.get("posts", "p1")).resolves.toEqual(document);

  await openSqliteStorage(sql);
  await expect(durable.get("posts", "p1")).resolves.toEqual(document);
  sql.close();
});

test("storage layout initialization does not own maintenance tables", async () => {
  const { SqliteMaintenanceBackend } = await import("../src/maintenance");
  const sql = createNodeSqliteExecutor();
  const storage = (await openSqliteStorage(sql)).storage;
  await storage.put("posts", meta({ id: "p1", title: "preserved" }));

  expect(await takibiTables(sql)).toEqual([
    "takibi_documents",
    "takibi_index_catalog",
    "takibi_metadata",
  ]);

  await sql.transaction(async (tx) => {
    await tx.exec("UPDATE takibi_metadata SET value = ? WHERE key = ?", 3, "layout_version");
  });

  const migrated = (await openSqliteStorage(sql)).storage;
  await expect(migrated.get("posts", "p1")).resolves.toMatchObject({ title: "preserved" });
  expect(await takibiTables(sql)).toEqual([
    "takibi_documents",
    "takibi_index_catalog",
    "takibi_metadata",
  ]);
  expect(
    (
      await one<{ value: number }>(
        sql,
        "SELECT value FROM takibi_metadata WHERE key = ?",
        "layout_version",
      )
    ).value,
  ).toBe(4);

  await SqliteMaintenanceBackend.open(sql);
  expect(await takibiTables(sql)).toEqual([
    "takibi_documents",
    "takibi_index_catalog",
    "takibi_maintenance_lease",
    "takibi_metadata",
    "takibi_restore_staging_documents",
    "takibi_restore_staging_unique",
  ]);
  sql.close();
});

test("SQLite migrates version 1 revisions and normalizes legacy values", async () => {
  const sql = await createVersionOneDatabase([
    { id: "valid", data: { title: "valid", rev: 9 } },
    { id: "missing", data: { title: "missing" } },
    { id: "fractional", data: { title: "fractional", rev: 1.5 } },
    { id: "string", data: { title: "string", rev: "4" } },
  ]);

  const durable = (await openSqliteStorage(sql)).storage;

  expect(
    await all<{ id: string; revision: number; json_revision_type: string | null }>(
      sql,
      `SELECT id, revision, json_type(data, '$.rev') AS json_revision_type
       FROM takibi_documents
       ORDER BY id`,
    ),
  ).toEqual([
    { id: "fractional", revision: 1, json_revision_type: null },
    { id: "missing", revision: 1, json_revision_type: null },
    { id: "string", revision: 1, json_revision_type: null },
    { id: "valid", revision: 9, json_revision_type: null },
  ]);
  await expect(durable.get("posts", "valid")).resolves.toMatchObject({
    title: "valid",
    rev: 9,
  });
  await expect(durable.get("posts", "missing")).resolves.toMatchObject({
    title: "missing",
    rev: 1,
  });
  sql.close();
});

test("SQLite keeps version 1 intact when revision migration copy fails", async () => {
  let rejectedCopy = false;
  const sql = await createVersionOneDatabase(
    [{ id: "p1", data: { title: "one", rev: 3 } }],
    onStatement((query) => {
      if (query.includes("INSERT INTO takibi_documents_v2")) {
        rejectedCopy = true;
        throw new Error("copy-failed");
      }
    }),
  );

  await expect(openSqliteStorage(sql)).rejects.toThrow("copy-failed");
  expect(rejectedCopy).toBe(true);
  expect(
    (
      await one<{ value: number }>(
        sql,
        "SELECT value FROM takibi_metadata WHERE key = ?",
        "layout_version",
      )
    ).value,
  ).toBe(1);
  expect(
    (
      await all<{ name: string }>(sql, "SELECT name FROM pragma_table_info('takibi_documents')")
    ).map(({ name }) => name),
  ).not.toContain("revision");
  expect(
    (
      await one<{ data: string }>(
        sql,
        "SELECT data FROM takibi_documents WHERE collection = ? AND id = ?",
        "posts",
        "p1",
      )
    ).data,
  ).toBe('{"title":"one","rev":3}');
  sql.close();
});

test("DO SQLite round-trips revisions beyond safe and signed 64-bit integer limits", async () => {
  const durable = (await openSqliteStorage(createNodeSqliteExecutor())).storage;
  const revisions = [1, 2 ** 53, 2 ** 63];

  for (const [index, revision] of revisions.entries()) {
    const document = {
      id: `p${index}`,
      title: String(revision),
      createdAt: TS,
      updatedAt: TS,
      rev: revision,
    } as StoredDocument;
    await durable.put("posts", document);
    await expect(durable.get("posts", document.id)).resolves.toEqual(document);
  }
});

test("indexed list pages by createdAt and id in both directions", async () => {
  const { compileIndexRegistry } = await import("../src/indexes");
  const { z } = await import("zod");
  const { fullAccess } = await import("takibi");

  const posts = {
    schema: z.object({ ownerId: z.string(), createdAt: z.string(), tag: z.string() }),
    accessPolicy: fullAccess,
    indexes: { byOwner: ["ownerId", "createdAt"] as const },
  };
  const registry = compileIndexRegistry({ posts });
  const durable = (await openSqliteStorage(createNodeSqliteExecutor(), registry)).storage;

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
    v: 4,
    index: "byOwner",
    orderField: "createdAt",
    direction: "desc",
    id: "c",
  });

  const second = await durable.list("posts", { ...desc, cursor: first.nextCursor });
  expect(second.items.map((document) => document.id)).toEqual(["a", "e"]);

  const asc = {
    index: "byOwner",
    where,
    orderBy: { field: "createdAt", direction: "asc" as const },
    limit: 10,
  };
  expect((await durable.list("posts", asc)).items.map((document) => document.id)).toEqual([
    "e",
    "a",
    "c",
    "b",
  ]);

  const residual = {
    index: "byOwner",
    where: {
      op: "and" as const,
      operands: [where, { field: "tag", op: "eq" as const, value: "keep" }],
    },
    orderBy: { field: "createdAt", direction: "desc" as const },
    limit: 2,
  };
  const filtered = await durable.list("posts", residual);
  expect(filtered.items.map((document) => document.id)).toEqual(["b", "c"]);
  expect(filtered.nextCursor).toBeDefined();
  const nextFiltered = await durable.list("posts", { ...residual, cursor: filtered.nextCursor });
  expect(nextFiltered.items.map((document) => document.id)).toEqual(["e"]);

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

  await durable.put("posts", {
    ...meta({ id: "f", ownerId: "u1", tag: "keep" }),
    createdAt: "2026-01-04T00:00:00.000Z",
  });
  expect(
    (await durable.list("posts", { ...desc, limit: 1 })).items.map((document) => document.id),
  ).toEqual(["f"]);
});
