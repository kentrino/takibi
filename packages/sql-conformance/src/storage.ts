import { describe, expect, test } from "vite-plus/test";
import { BadRequestError } from "@takibi/api";
import type { QueryExpr } from "@takibi/shared-types";
import {
  compileIndexedScanSql,
  compileIndexRegistry,
  openSqliteStorage,
  physicalIndexName,
  reconcileCollectionIndexes,
  resolveIndexedList,
  type StorageDriver,
  type StoredDocument,
} from "@takibi/storage";
import { plain, type ConformanceTarget } from "./target";

const TS = "2026-08-31T00:00:00.000Z";

function document(id: string, fields: Record<string, unknown> = {}): StoredDocument {
  return { id, createdAt: TS, updatedAt: TS, rev: 1, ...fields };
}

export const expectedStorageContractObservation = {
  firstPage: ["a", "c"],
  secondPage: ["d"],
  committed: "committed",
  rolledBack: null,
} as const;

/** Paging, nested commit, and rollback through one storage driver. */
export async function observeStorageContract(storage: StorageDriver) {
  for (const item of [
    document("d", { owner: "u1", score: 30 }),
    document("a", { owner: "u1", score: 10 }),
    document("c", { owner: "u1", score: 20 }),
    document("b", { owner: "u2", score: 40 }),
  ]) {
    await storage.put("shared-contract", item);
  }

  const where = { field: "owner", op: "eq", value: "u1" } as const;
  const first = await storage.list("shared-contract", { where, limit: 2 });
  const second = await storage.list("shared-contract", {
    where,
    limit: 2,
    cursor: first.nextCursor,
  });

  await storage.transaction(async (transaction) => {
    await transaction.put("shared-contract", document("committed", { owner: "tx", score: 1 }));
    await transaction.transaction(async (nested) => {
      await nested.put("shared-contract", document("nested", { owner: "tx", score: 2 }));
    });
  });
  try {
    await storage.transaction(async (transaction) => {
      await transaction.put("shared-contract", document("rolled-back", { owner: "tx", score: 3 }));
      throw new Error("roll back shared contract write");
    });
  } catch {}

  return {
    firstPage: first.items.map(({ id }) => id),
    secondPage: second.items.map(({ id }) => id),
    committed: (await storage.get("shared-contract", "committed"))?.id ?? null,
    rolledBack: (await storage.get("shared-contract", "rolled-back"))?.id ?? null,
  };
}

async function listAll(storage: StorageDriver, collection: string, where?: QueryExpr) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(collection, {
      limit: 7,
      ...(where === undefined ? {} : { where }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    ids.push(...page.items.map(({ id }) => id));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return ids;
}

/** The storage driver, index planning, and layout over the SQL port. */
export function defineStorageTests(target: ConformanceTarget): void {
  describe("storage driver", () => {
    test("satisfies the shared storage contract", () =>
      target.withDatabase("storage-contract", async (sql) => {
        const storage = await openSqliteStorage(sql);
        expect(await observeStorageContract(storage)).toEqual(expectedStorageContractObservation);
      }));

    test("pages across internal chunks without gaps or repeats", () =>
      target.withDatabase("storage-paging", async (sql) => {
        const storage = await openSqliteStorage(sql);
        const ids = Array.from(
          { length: 300 },
          (_, index) => `doc-${String(index).padStart(3, "0")}`,
        );
        for (const id of [...ids].reverse()) {
          await storage.put("posts", document(id, { even: Number(id.slice(4)) % 2 === 0 }));
        }
        const page = await storage.list("posts", { limit: 200 });
        expect(page.items).toHaveLength(200);
        const rest = await storage.list("posts", { limit: 200, cursor: page.nextCursor });
        expect([...page.items, ...rest.items].map(({ id }) => id)).toEqual(ids);
        expect(rest.nextCursor).toBeUndefined();
        // Sparse matches are found across chunks, filtered before the limit.
        expect(await listAll(storage, "posts", { field: "even", op: "eq", value: true })).toEqual(
          ids.filter((_, index) => index % 2 === 0),
        );
      }));

    test("query operators match by JSON type", () =>
      target.withDatabase("storage-operators", async (sql) => {
        const storage = await openSqliteStorage(sql);
        const docs = [
          document("a", { title: "Alpha beta", score: 1, flag: true, note: null }),
          document("b", { title: "beta", score: 2.5, flag: false }),
          document("c", { title: "gamma", score: "2" }),
          document("d", { title: "ALPHA", score: 10 }),
        ];
        for (const doc of docs) await storage.put("items", doc);
        const ids = (where: QueryExpr) => listAll(storage, "items", where);
        expect(await ids({ field: "score", op: "gt", value: 1 })).toEqual(["b", "d"]);
        expect(await ids({ field: "score", op: "eq", value: "2" })).toEqual(["c"]);
        expect(await ids({ field: "score", op: "in", values: [1, 10] })).toEqual(["a", "d"]);
        expect(await ids({ field: "title", op: "startsWith", value: "Alpha" })).toEqual(["a"]);
        expect(await ids({ field: "title", op: "contains", value: "beta" })).toEqual(["a", "b"]);
        expect(await ids({ field: "title", op: "endsWith", value: "ma" })).toEqual(["c"]);
        expect(await ids({ field: "flag", op: "eq", value: false })).toEqual(["b"]);
        expect(await ids({ field: "note", op: "eq", value: null })).toEqual(["a"]);
        expect(await ids({ field: "note", op: "present" })).toEqual(["a"]);
        expect(
          await ids({
            op: "or",
            operands: [
              { field: "flag", op: "eq", value: true },
              { op: "not", operand: { field: "score", op: "lte", value: 5 } },
            ],
          }),
        ).toEqual(["a", "c", "d"]);
      }));

    test("collections are isolated and cursors are bound to their collection and query", () =>
      target.withDatabase("storage-isolation", async (sql) => {
        const storage = await openSqliteStorage(sql);
        await storage.put("posts", document("same", { owner: "u1" }));
        await storage.put("posts", document("other", { owner: "u1" }));
        await storage.put("users", document("same", { owner: "u2" }));
        expect(await storage.get("posts", "same")).toMatchObject({ owner: "u1" });
        expect(await storage.get("users", "same")).toMatchObject({ owner: "u2" });
        await expect(storage.delete("users", "same")).resolves.toBe(true);
        await expect(storage.delete("users", "same")).resolves.toBe(false);
        expect(await storage.get("posts", "same")).not.toBeNull();

        const where = { field: "owner", op: "eq", value: "u1" } as const;
        const page = await storage.list("posts", { where, limit: 1 });
        expect(page.nextCursor).toBeDefined();
        await expect(
          storage.list("users", { where, limit: 1, cursor: page.nextCursor }),
        ).rejects.toBeInstanceOf(BadRequestError);
        await expect(
          storage.list("posts", {
            where: { field: "owner", op: "eq", value: "u2" },
            cursor: page.nextCursor,
          }),
        ).rejects.toBeInstanceOf(BadRequestError);
      }));

    test("revisions round-trip across numeric storage boundaries", () =>
      target.withDatabase("storage-revisions", async (sql) => {
        const storage = await openSqliteStorage(sql);
        for (const rev of [1, 2 ** 53 - 1, 2 ** 53, 2 ** 63, 2 ** 64, Number.MAX_VALUE]) {
          await storage.put("revs", document(`r${rev}`, { rev }));
          expect((await storage.get("revs", `r${rev}`))?.rev).toBe(rev);
        }
      }));

    test("layout initialisation is idempotent and refuses a newer layout", () =>
      target.withDatabase("storage-layout", async (sql) => {
        const storage = await openSqliteStorage(sql);
        await storage.put("posts", document("kept"));
        const reopened = await openSqliteStorage(sql);
        expect(await reopened.get("posts", "kept")).toMatchObject({ id: "kept" });
        await sql.exec("UPDATE takibi_metadata SET value = 999 WHERE key = 'layout_version'");
        await expect(openSqliteStorage(sql)).rejects.toMatchObject({
          code: "STORAGE_LAYOUT_VERSION",
        });
      }));

    test("indexed lists page by index order in both directions", () =>
      target.withDatabase("storage-indexed-list", async (sql) => {
        const collections = { posts: { indexes: { byOwner: ["ownerId", "createdAt"] as const } } };
        const registry = compileIndexRegistry(collections);
        const storage = await openSqliteStorage(sql, registry);
        await reconcileCollectionIndexes({ storage, collections, registry });
        const docs = [
          { ...document("c", { ownerId: "u1" }), createdAt: "2026-01-01T00:00:00.000Z" },
          { ...document("a", { ownerId: "u1" }), createdAt: "2026-01-01T00:00:00.000Z" },
          { ...document("b", { ownerId: "u1" }), createdAt: "2026-01-02T00:00:00.000Z" },
          { ...document("d", { ownerId: "u2" }), createdAt: "2026-01-03T00:00:00.000Z" },
          { ...document("e", { ownerId: "u1" }), createdAt: "2025-12-31T00:00:00.000Z" },
        ];
        for (const doc of docs) await storage.put("posts", doc);
        const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
        const desc = {
          index: "byOwner",
          where,
          orderBy: { field: "createdAt", direction: "desc" as const },
          limit: 2,
        };
        const first = await storage.list("posts", desc);
        expect(first.items.map(({ id }) => id)).toEqual(["b", "c"]);
        const second = await storage.list("posts", { ...desc, cursor: first.nextCursor });
        expect(second.items.map(({ id }) => id)).toEqual(["a", "e"]);
        const ascending = await storage.list("posts", {
          index: "byOwner",
          where,
          orderBy: { field: "createdAt", direction: "asc" },
          limit: 10,
        });
        expect(ascending.items.map(({ id }) => id)).toEqual(["e", "a", "c", "b"]);
        await expect(
          storage.list("posts", {
            ...desc,
            where: { field: "ownerId", op: "eq", value: "u2" },
            cursor: first.nextCursor,
          }),
        ).rejects.toBeInstanceOf(BadRequestError);
      }));

    test("index reconciliation builds partial expression indexes the planner uses", () =>
      target.withDatabase("storage-index-reconcile", async (sql) => {
        const first = { posts: { indexes: { byOwner: ["ownerId", "createdAt"] as const } } };
        const firstRegistry = compileIndexRegistry(first);
        const storage = await openSqliteStorage(sql, firstRegistry);
        await storage.put("posts", document("p1", { ownerId: "u1" }));
        await reconcileCollectionIndexes({ storage, collections: first, registry: firstRegistry });
        // Reconciling again changes nothing.
        await reconcileCollectionIndexes({ storage, collections: first, registry: firstRegistry });

        const renamed = { posts: { indexes: { byCreator: ["ownerId", "createdAt"] as const } } };
        await reconcileCollectionIndexes({
          storage,
          collections: renamed,
          registry: compileIndexRegistry(renamed),
        });
        const names = (
          await sql.exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%'",
          )
        ).rows.map((row) => plain(row)!.name);
        expect(names).toEqual([physicalIndexName("posts", "byCreator", ["ownerId", "createdAt"])]);
        const catalog = (
          await sql.exec<{ public_name: string }>("SELECT public_name FROM takibi_index_catalog")
        ).rows.map((row) => plain(row)!.public_name);
        expect(catalog).toEqual(["byCreator"]);

        // The planner uses the reconciled partial expression index. This runs
        // last: libSQL (libsql 0.5.29) leaves an EXPLAIN statement active, and
        // a later DROP INDEX on the same connection then fails with
        // SQLITE_LOCKED. The engine itself never issues EXPLAIN.
        const scan = resolveIndexedList(
          "posts",
          {
            index: "byCreator",
            where: { field: "ownerId", op: "eq", value: "u1" },
            orderBy: { field: "createdAt", direction: "desc" },
          },
          compileIndexRegistry(renamed),
        );
        const compiled = compileIndexedScanSql("posts", scan!, { limit: 20 });
        const plan = (
          await sql.exec<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${compiled.sql}`,
            ...compiled.bindings,
          )
        ).rows
          .map((row) => row.detail)
          .join("\n");
        expect(plan).toContain(physicalIndexName("posts", "byCreator", ["ownerId", "createdAt"]));
      }));

    test("index reconciliation refuses documents missing an indexed field and changes nothing", () =>
      target.withDatabase("storage-index-backfill", async (sql) => {
        const collections = { posts: { indexes: { byOwner: ["ownerId"] as const } } };
        const registry = compileIndexRegistry(collections);
        const storage = await openSqliteStorage(sql, registry);
        await storage.put("posts", document("p1"));
        await expect(
          reconcileCollectionIndexes({ storage, collections, registry }),
        ).rejects.toThrow();
        expect(
          (
            await sql.exec(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%'",
            )
          ).rows,
        ).toEqual([]);
      }));
  });
}
