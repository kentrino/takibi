import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "takibi";
import { compileIndexedScanSql, physicalIndexName } from "../src/index-sql";
import { compileIndexRegistry, resolveIndexedList } from "../src/indexes";
import { createMigratingStorage } from "../src/migrations";
import { openSqliteStorage } from "../src/storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";
import { all, onStatement } from "./helpers/node-sql";
import type { CollectionsDef, WithMetadata } from "../src/types";

const TS = "2026-08-09T14:12:00.000Z";

function meta<T extends Record<string, unknown>>(doc: { id: string } & T): WithMetadata<T> {
  return { ...doc, createdAt: TS, updatedAt: TS, rev: 1 };
}

const posts = {
  schema: z.object({
    ownerId: z.string(),
    createdAt: z.string(),
    score: z.number(),
    label: z.string(),
  }),
  accessPolicy: fullAccess,
  indexes: { byOwner: ["ownerId", "createdAt"] as const, byScore: ["score"] as const },
};

test.each(["null", '"score"', "{}", "[1]", '["score", null]', "not-json"])(
  "index reconcile rejects invalid catalog fields %s before changing indexes",
  async (fieldsJson) => {
    const collections = { posts };
    const sql = createNodeSqliteExecutor();
    const { indexes } = await openSqliteStorage(sql, compileIndexRegistry(collections));
    await indexes.reconcile({
      collections,
    });
    await sql.exec("UPDATE takibi_index_catalog SET fields_json = ?", fieldsJson);
    const before = await all(sql, "SELECT * FROM takibi_index_catalog");
    await expect(
      indexes.reconcile({
        collections,
      }),
    ).rejects.toThrow(/Invalid index catalog fields/);
    expect(await all(sql, "SELECT * FROM takibi_index_catalog")).toEqual(before);
    sql.close();
  },
);

test("index reconcile rejects a registry with missing definitions before dropping existing indexes", async () => {
  const collections = { posts };
  const sql = createNodeSqliteExecutor();
  const { indexes } = await openSqliteStorage(sql, compileIndexRegistry(collections));
  await indexes.reconcile({
    collections,
  });
  const snapshot = async () => ({
    catalog: await all(sql, "SELECT * FROM takibi_index_catalog"),
    physical: await all(
      sql,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%'",
    ),
  });
  const before = await snapshot();
  const registry = compileIndexRegistry({ missing: posts });

  await expect(
    indexes.reconcile({
      collections,
      registry,
    }),
  ).rejects.toThrow("Missing collection definition for missing");
  expect(await snapshot()).toEqual(before);
  sql.close();
});

test("SQLite query plan uses the declared expression index", async () => {
  const collections = { posts };
  const registry = compileIndexRegistry(collections);
  const sql = createNodeSqliteExecutor();
  const { storage: durable, indexes } = await openSqliteStorage(sql, registry);
  const migrating = createMigratingStorage(collections as unknown as CollectionsDef, durable);
  await indexes.reconcile({
    collections,
    reader: migrating,
    registry,
  });

  await durable.put(
    "posts",
    meta({ id: "p1", ownerId: "u1", createdAt: "2026-01-02T00:00:00.000Z", score: 2, label: "a" }),
  );

  const scan = resolveIndexedList(
    "posts",
    {
      index: "byOwner",
      where: { field: "ownerId", op: "eq", value: "u1" },
      orderBy: { field: "createdAt", direction: "desc" },
    },
    registry,
  );
  expect(scan).toBeDefined();
  const compiled = compileIndexedScanSql("posts", scan!, { limit: 20 });
  const plan = (
    await all<{ detail: string }>(sql, `EXPLAIN QUERY PLAN ${compiled.sql}`, ...compiled.bindings)
  )
    .map((row) => row.detail)
    .join("\n");
  expect(plan).toContain(physicalIndexName("posts", "byOwner", ["ownerId", "createdAt"]));
});

test("index reconcile drops renamed indexes and optimizes only after DDL", async () => {
  let optimizeCount = 0;
  const sql = createNodeSqliteExecutor(
    onStatement((query) => {
      if (query === "PRAGMA optimize") optimizeCount += 1;
    }),
  );
  const first = {
    posts: {
      ...posts,
      indexes: { byOwner: ["ownerId", "createdAt"] as const },
    },
  };
  const firstRegistry = compileIndexRegistry(first);
  const { storage: durable, indexes } = await openSqliteStorage(sql, firstRegistry);
  const migrating = createMigratingStorage(first as unknown as CollectionsDef, durable);

  await indexes.reconcile({
    collections: first,
    reader: migrating,
    registry: firstRegistry,
  });
  expect(optimizeCount).toBe(1);

  await indexes.reconcile({
    collections: first,
    reader: migrating,
    registry: firstRegistry,
  });
  expect(optimizeCount).toBe(1);

  const renamed = {
    posts: {
      ...posts,
      indexes: { byCreator: ["ownerId", "createdAt"] as const },
    },
  };
  await indexes.reconcile({
    collections: renamed,
    reader: createMigratingStorage(renamed as unknown as CollectionsDef, durable),
    registry: compileIndexRegistry(renamed),
  });
  expect(optimizeCount).toBe(2);

  const names = (
    await all<{ name: string }>(
      sql,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%'`,
    )
  ).map((row) => row.name);
  expect(names).toEqual([physicalIndexName("posts", "byCreator", ["ownerId", "createdAt"])]);
  const catalog = (
    await all<{ public_name: string }>(sql, "SELECT public_name FROM takibi_index_catalog")
  ).map((row) => row.public_name);
  expect(catalog).toEqual(["byCreator"]);
});

test("index reconcile succeeds when the database refuses the optimize hint", async () => {
  // sqld rejects `PRAGMA optimize` as an unsupported statement.
  const sql = createNodeSqliteExecutor((connection) => ({
    ...connection,
    async exec(query, ...bindings) {
      if (query === "PRAGMA optimize") throw new Error("unsupported statement: PRAGMA optimize");
      return connection.exec(query, ...bindings);
    },
  }));
  const collections = { posts };
  const registry = compileIndexRegistry(collections);
  const { indexes } = await openSqliteStorage(sql, registry);
  await indexes.reconcile({ collections, registry });
  const names = (
    await all<{ name: string }>(
      sql,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%' ORDER BY name`,
    )
  ).map((row) => row.name);
  expect(names).toHaveLength(2);
});

test("SQLite backfill preserves indexed order for mixed keys", async () => {
  const collections = { posts };
  const registry = compileIndexRegistry(collections);
  const sql = createNodeSqliteExecutor();
  const { storage: durable, indexes } = await openSqliteStorage(sql, registry);
  const migratingDurable = createMigratingStorage(
    collections as unknown as CollectionsDef,
    durable,
  );
  await indexes.reconcile({
    collections,
    reader: migratingDurable,
    registry,
  });

  const docs = [
    meta({ id: "m", ownerId: "u1", createdAt: "2026-01-01T00:00:00.000Z", score: 10, label: "é" }),
    meta({ id: "n", ownerId: "u1", createdAt: "2026-01-01T00:00:00.000Z", score: 2, label: "e" }),
    meta({ id: "o", ownerId: "u1", createdAt: "2026-01-02T00:00:00.000Z", score: 2, label: "a" }),
  ];
  for (const doc of docs) {
    await migratingDurable.put("posts", doc);
  }

  const opts = {
    index: "byOwner",
    where: { field: "ownerId" as const, op: "eq" as const, value: "u1" },
    orderBy: { field: "createdAt", direction: "asc" as const },
  };
  const durablePage = await durable.list("posts", opts);
  expect(durablePage.items.map((document) => document.id)).toEqual(["m", "n", "o"]);
  expect(durablePage.nextCursor).toBeUndefined();
});

test("the opened SQLite storage hands back a driver and index reconcile, never a SQL handle", async () => {
  const sql = createNodeSqliteExecutor();
  const opened = await openSqliteStorage(sql);
  expect(Object.keys(opened).sort()).toEqual(["indexes", "storage"]);
  expect(Object.keys(opened.storage).sort()).toEqual([
    "delete",
    "get",
    "list",
    "put",
    "transaction",
  ]);
  expect(Object.keys(opened.indexes)).toEqual(["reconcile"]);
  for (const part of [opened, opened.storage, opened.indexes]) {
    expect(Object.values(part as object)).not.toContain(sql);
  }
  sql.close();
});

test.each([
  /^DROP INDEX/,
  /^DELETE FROM takibi_index_catalog/,
  /^CREATE INDEX/,
  /^INSERT INTO takibi_index_catalog/,
])(
  "index reconcile failing at %s leaves the catalog and physical indexes unchanged",
  async (failing) => {
    let fail = false;
    const sql = createNodeSqliteExecutor(
      onStatement((query) => {
        if (fail && failing.test(query.trim())) throw new Error("reconcile-failed");
      }),
    );
    const first = { posts };
    const { indexes } = await openSqliteStorage(sql, compileIndexRegistry(first));
    await indexes.reconcile({ collections: first });
    const snapshot = async () => ({
      catalog: await all(sql, "SELECT * FROM takibi_index_catalog ORDER BY physical_name"),
      physical: await all(
        sql,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%' ORDER BY name",
      ),
    });
    const before = await snapshot();
    expect(before.catalog).toHaveLength(2);

    // Renaming byOwner drops one index and catalog row and builds another.
    const renamed = {
      posts: {
        ...posts,
        indexes: { byCreator: ["ownerId", "createdAt"] as const, byScore: ["score"] as const },
      },
    };
    fail = true;
    await expect(
      indexes.reconcile({
        collections: renamed,
        registry: compileIndexRegistry(renamed),
      }),
    ).rejects.toThrow("reconcile-failed");
    expect(await snapshot()).toEqual(before);

    fail = false;
    await indexes.reconcile({
      collections: renamed,
      registry: compileIndexRegistry(renamed),
    });
    const after = await snapshot();
    expect(after.catalog.map((row) => row.physical_name)).toEqual(
      after.physical.map((row) => row.name),
    );
    expect(new Set(after.catalog.map((row) => row.public_name))).toEqual(
      new Set(["byCreator", "byScore"]),
    );
    sql.close();
  },
);
