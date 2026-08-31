import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import type { QueryExpr, StoredDocument, WithMetadata } from "../src/types";
import { generateUlid, isUlid, resetUlidStateForTests } from "../src/ulid";
import { createSqliteDurableObjectStorage } from "./sqlite";

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

function createVersionOneStorage(
  rows: Array<{
    id: string;
    data: Record<string, unknown>;
  }>,
): DurableObjectStorage {
  const storage = createSqliteDurableObjectStorage();
  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE takibi_metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
    storage.sql.exec("INSERT INTO takibi_metadata (key, value) VALUES (?, ?)", "layout_version", 1);
    storage.sql.exec(
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
      storage.sql.exec(
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
  return storage;
}

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

test("memory and DO SQLite pagination agree on order, boundary, and nextCursor", async () => {
  const memory = createMemoryStorage();
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());

  const docs = [
    meta({ id: "c", title: "C" }),
    meta({ id: "a", title: "A" }),
    meta({ id: "b", title: "B" }),
    meta({ id: "d", title: "D" }),
    meta({ id: "e", title: "E" }),
  ];

  for (const doc of docs) {
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  // Distinct resources with the same id must not collide on DO keys.
  await durable.put("comments", meta({ id: "a", body: "x" }));
  expect(await durable.get("posts", "a")).toEqual(meta({ id: "a", title: "A" }));
  expect(await durable.get("comments", "a")).toEqual(meta({ id: "a", body: "x" }));

  const page1Memory = await memory.list("posts", { limit: 2 });
  const page1Durable = await durable.list("posts", { limit: 2 });
  expect(page1Memory).toEqual(page1Durable);
  expect(page1Memory.items.map((d) => d.id)).toEqual(["a", "b"]);
  expect(decodeCursor(page1Memory.nextCursor!)).toEqual({
    v: 2,
    collection: "posts",
    where: null,
    id: "b",
  });

  const page2Memory = await memory.list("posts", { limit: 2, cursor: page1Memory.nextCursor });
  const page2Durable = await durable.list("posts", { limit: 2, cursor: page1Durable.nextCursor });
  expect(page2Memory).toEqual(page2Durable);
  expect(page2Memory.items.map((d) => d.id)).toEqual(["c", "d"]);
  expect(decodeCursor(page2Memory.nextCursor!)).toMatchObject({ id: "d" });

  const page3Memory = await memory.list("posts", { limit: 2, cursor: page2Memory.nextCursor });
  const page3Durable = await durable.list("posts", { limit: 2, cursor: page2Durable.nextCursor });
  expect(page3Memory).toEqual(page3Durable);
  expect(page3Memory.items.map((d) => d.id)).toEqual(["e"]);
  expect(page3Memory.nextCursor).toBeUndefined();

  // Missing cursor seeks past that key (startAfter), not rewind to the start.
  const missingCursor = encodeCursor({
    ...decodeCursor(page1Memory.nextCursor!),
    id: "a0",
  });
  const afterMissingMemory = await memory.list("posts", { limit: 10, cursor: missingCursor });
  const afterMissingDurable = await durable.list("posts", { limit: 10, cursor: missingCursor });
  expect(afterMissingMemory).toEqual(afterMissingDurable);
  expect(afterMissingMemory.items.map((d) => d.id)).toEqual(["b", "c", "d", "e"]);

  await expect(memory.list("posts", { cursor: "b" })).rejects.toBeInstanceOf(BadRequestError);
});

test("memory and DO filter before limit with query-bound cursors", async () => {
  const memory = createMemoryStorage();
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
  const docs = [
    meta({ id: "a", ownerId: "u2", score: 30 }),
    meta({ id: "b", ownerId: "u1", score: 10 }),
    meta({ id: "c", ownerId: "u2", score: 20 }),
    meta({ id: "d", ownerId: "u1", score: 20 }),
    meta({ id: "e", ownerId: "u1", score: 30 }),
  ];
  for (const doc of docs) {
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
  const firstMemory = await memory.list("posts", { limit: 2, where });
  const firstDurable = await durable.list("posts", { limit: 2, where });
  expect(firstMemory).toEqual(firstDurable);
  expect(firstMemory.items.map((document) => document.id)).toEqual(["b", "d"]);
  expect(decodeCursor(firstMemory.nextCursor!)).toEqual({
    v: 2,
    collection: "posts",
    where,
    id: "d",
  });

  const secondMemory = await memory.list("posts", {
    limit: 2,
    where,
    cursor: firstMemory.nextCursor,
  });
  const secondDurable = await durable.list("posts", {
    limit: 2,
    where,
    cursor: firstDurable.nextCursor,
  });
  expect(secondMemory).toEqual(secondDurable);
  expect(secondMemory.items.map((document) => document.id)).toEqual(["e"]);

  await expect(
    memory.list("comments", { where, cursor: firstMemory.nextCursor }),
  ).rejects.toBeInstanceOf(BadRequestError);
  await expect(
    memory.list("posts", {
      where: { field: "ownerId", op: "eq", value: "u2" },
      cursor: firstMemory.nextCursor,
    }),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("memory and DO SQLite agree on in and case-sensitive string matching", async () => {
  const memory = createMemoryStorage();
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
  const documents = [
    meta({ id: "a", value: "YR Clinic" }),
    meta({ id: "b", value: "yr clinic" }),
    meta({ id: "c", value: null }),
    meta({ id: "d", value: 1 }),
    meta({ id: "e" }),
  ];
  for (const document of documents) {
    await memory.put("items", document);
    await durable.put("items", document);
  }

  const queries: QueryExpr[] = [
    { field: "value", op: "in", values: ["YR Clinic", null] },
    { op: "not", operand: { field: "value", op: "in", values: ["yr clinic"] } },
    { field: "value", op: "contains", value: "Clinic" },
    { field: "value", op: "startsWith", value: "YR" },
    { field: "value", op: "endsWith", value: "" },
  ];
  for (const where of queries) {
    await expect(durable.list("items", { where })).resolves.toEqual(
      await memory.list("items", { where }),
    );
  }
});

test("DO SQLite list finds sparse matches across internal chunks", async () => {
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());

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
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
  await durable.put("posts", meta({ id: "p1", title: "hi" }));
  await durable.put("comments", meta({ id: "p1", title: "other" }));

  expect(await durable.get("posts", "p1")).toEqual(meta({ id: "p1", title: "hi" }));
  expect(await durable.get("comments", "p1")).toEqual(meta({ id: "p1", title: "other" }));
  expect(await durable.get("posts", "missing")).toBeNull();
});

test("DO SQLite layout stores revision in a dedicated REAL column", async () => {
  const backing = createSqliteDurableObjectStorage();
  const durable = createDurableObjectStorage(backing);
  const document = { ...meta({ id: "p1", title: "one" }), rev: 7 };

  await durable.put("posts", document);

  expect(
    backing.sql
      .exec<{ value: number }>("SELECT value FROM takibi_metadata WHERE key = ?", "layout_version")
      .one().value,
  ).toBe(3);
  expect(
    backing.sql
      .exec<{ name: string; type: string; notnull: number }>(
        `SELECT name, type, "notnull"
         FROM pragma_table_info('takibi_documents')
         WHERE name = 'revision'`,
      )
      .one(),
  ).toEqual({ name: "revision", type: "REAL", notnull: 1 });
  expect(
    backing.sql
      .exec<{ revision: number; json_revision_type: string | null }>(
        `SELECT revision, json_type(data, '$.rev') AS json_revision_type
         FROM takibi_documents
         WHERE collection = ? AND id = ?`,
        "posts",
        "p1",
      )
      .one(),
  ).toEqual({ revision: 7, json_revision_type: null });
  await expect(durable.get("posts", "p1")).resolves.toEqual(document);

  createDurableObjectStorage(backing);
  await expect(durable.get("posts", "p1")).resolves.toEqual(document);
});

test("DO SQLite migrates version 1 revisions and normalizes legacy values", async () => {
  const backing = createVersionOneStorage([
    { id: "valid", data: { title: "valid", rev: 9 } },
    { id: "missing", data: { title: "missing" } },
    { id: "fractional", data: { title: "fractional", rev: 1.5 } },
    { id: "string", data: { title: "string", rev: "4" } },
  ]);

  const durable = createDurableObjectStorage(backing);

  expect(
    backing.sql
      .exec<{ id: string; revision: number; json_revision_type: string | null }>(
        `SELECT id, revision, json_type(data, '$.rev') AS json_revision_type
         FROM takibi_documents
         ORDER BY id`,
      )
      .toArray(),
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
});

test("DO SQLite keeps version 1 intact when revision migration copy fails", () => {
  const backing = createVersionOneStorage([{ id: "p1", data: { title: "one", rev: 3 } }]);
  const exec = backing.sql.exec.bind(backing.sql);
  let rejectedCopy = false;
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (query.includes("INSERT INTO takibi_documents_v2")) {
      rejectedCopy = true;
      throw new Error("copy-failed");
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  expect(() => createDurableObjectStorage(backing)).toThrow("copy-failed");
  expect(rejectedCopy).toBe(true);
  expect(
    backing.sql
      .exec<{ value: number }>("SELECT value FROM takibi_metadata WHERE key = ?", "layout_version")
      .one().value,
  ).toBe(1);
  expect(
    backing.sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('takibi_documents')")
      .toArray()
      .map(({ name }) => name),
  ).not.toContain("revision");
  expect(
    backing.sql
      .exec<{ data: string }>(
        "SELECT data FROM takibi_documents WHERE collection = ? AND id = ?",
        "posts",
        "p1",
      )
      .one().data,
  ).toBe('{"title":"one","rev":3}');
});

test("DO SQLite round-trips revisions beyond safe and signed 64-bit integer limits", async () => {
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
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
  const { fullAccess } = await import("../src/index");

  const posts = {
    schema: z.object({ ownerId: z.string(), createdAt: z.string(), tag: z.string() }),
    accessPolicy: fullAccess,
    indexes: { byOwner: ["ownerId", "createdAt"] as const },
  };
  const registry = compileIndexRegistry({ posts });
  const memory = createMemoryStorage(registry);
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage(), registry);

  const docs = [
    { ...meta({ id: "c", ownerId: "u1", tag: "keep" }), createdAt: "2026-01-01T00:00:00.000Z" },
    { ...meta({ id: "a", ownerId: "u1", tag: "skip" }), createdAt: "2026-01-01T00:00:00.000Z" },
    { ...meta({ id: "b", ownerId: "u1", tag: "keep" }), createdAt: "2026-01-02T00:00:00.000Z" },
    { ...meta({ id: "d", ownerId: "u2", tag: "keep" }), createdAt: "2026-01-03T00:00:00.000Z" },
    { ...meta({ id: "e", ownerId: "u1", tag: "keep" }), createdAt: "2026-01-00T00:00:00.000Z" },
  ];
  for (const doc of docs) {
    await memory.put("posts", doc);
    await durable.put("posts", doc);
  }

  const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
  const desc = {
    index: "byOwner",
    where,
    orderBy: { field: "createdAt", direction: "desc" as const },
    limit: 2,
  };
  const firstMemory = await memory.list("posts", desc);
  const firstDurable = await durable.list("posts", desc);
  expect(firstMemory.items.map((document) => document.id)).toEqual(["b", "c"]);
  expect(firstDurable.items.map((document) => document.id)).toEqual(["b", "c"]);
  expect(decodeCursor(firstMemory.nextCursor!)).toMatchObject({
    v: 3,
    index: "byOwner",
    orderField: "createdAt",
    direction: "desc",
    id: "c",
  });

  const secondMemory = await memory.list("posts", { ...desc, cursor: firstMemory.nextCursor });
  const secondDurable = await durable.list("posts", { ...desc, cursor: firstDurable.nextCursor });
  expect(secondMemory.items.map((document) => document.id)).toEqual(["a", "e"]);
  expect(secondDurable).toEqual(secondMemory);

  const asc = {
    index: "byOwner",
    where,
    orderBy: { field: "createdAt", direction: "asc" as const },
    limit: 10,
  };
  expect((await memory.list("posts", asc)).items.map((document) => document.id)).toEqual([
    "e",
    "a",
    "c",
    "b",
  ]);
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
  const filtered = await memory.list("posts", residual);
  expect(filtered.items.map((document) => document.id)).toEqual(["b", "c"]);
  expect(filtered.nextCursor).toBeDefined();
  const nextFiltered = await memory.list("posts", { ...residual, cursor: filtered.nextCursor });
  expect(nextFiltered.items.map((document) => document.id)).toEqual(["e"]);
  expect(await durable.list("posts", residual)).toEqual(filtered);

  await expect(
    memory.list("posts", {
      ...desc,
      where: { field: "ownerId", op: "eq", value: "u2" },
      cursor: firstMemory.nextCursor,
    }),
  ).rejects.toBeInstanceOf(BadRequestError);
  await expect(
    memory.list("posts", { orderBy: { field: "createdAt", direction: "desc" } }),
  ).rejects.toBeInstanceOf(BadRequestError);
  await expect(memory.list("posts", { index: "missing", where })).rejects.toBeInstanceOf(
    BadRequestError,
  );

  await memory.put("posts", {
    ...meta({ id: "f", ownerId: "u1", tag: "keep" }),
    createdAt: "2026-01-04T00:00:00.000Z",
  });
  expect(
    (await memory.list("posts", { ...desc, limit: 1 })).items.map((document) => document.id),
  ).toEqual(["f"]);
});
