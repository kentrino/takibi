import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "../src/index";
import { compileIndexedScanSql, physicalIndexName } from "../src/index-sql";
import { backfillIndexedCollections, reconcileCollectionIndexes } from "../src/index-reconcile";
import { compileIndexRegistry, resolveIndexedList } from "../src/indexes";
import { createMigratingStorage } from "../src/migrations";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import type { CollectionsDef, WithMetadata } from "../src/types";
import { createSqliteDurableObjectStorage } from "./sqlite";

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

test("SQLite query plan uses the declared expression index", async () => {
  const collections = { posts };
  const registry = compileIndexRegistry(collections);
  const backing = createSqliteDurableObjectStorage();
  const durable = createDurableObjectStorage(backing, registry);
  const migrating = createMigratingStorage(collections as unknown as CollectionsDef, durable);
  await reconcileCollectionIndexes({
    sql: backing.sql,
    collections,
    storage: migrating,
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
  const plan = backing.sql
    .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${compiled.sql}`, ...compiled.bindings)
    .toArray()
    .map((row) => row.detail)
    .join("\n");
  expect(plan).toContain(physicalIndexName("posts", "byOwner", ["ownerId", "createdAt"]));
});

test("index reconcile drops renamed indexes and optimizes only after DDL", async () => {
  const backing = createSqliteDurableObjectStorage();
  const first = {
    posts: {
      ...posts,
      indexes: { byOwner: ["ownerId", "createdAt"] as const },
    },
  };
  const firstRegistry = compileIndexRegistry(first);
  const durable = createDurableObjectStorage(backing, firstRegistry);
  const migrating = createMigratingStorage(first as unknown as CollectionsDef, durable);
  let optimizeCount = 0;
  const exec = backing.sql.exec.bind(backing.sql);
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (query === "PRAGMA optimize") optimizeCount += 1;
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  await reconcileCollectionIndexes({
    sql: backing.sql,
    collections: first,
    storage: migrating,
    registry: firstRegistry,
  });
  expect(optimizeCount).toBe(1);

  await reconcileCollectionIndexes({
    sql: backing.sql,
    collections: first,
    storage: migrating,
    registry: firstRegistry,
  });
  expect(optimizeCount).toBe(1);

  const renamed = {
    posts: {
      ...posts,
      indexes: { byCreator: ["ownerId", "createdAt"] as const },
    },
  };
  await reconcileCollectionIndexes({
    sql: backing.sql,
    collections: renamed,
    storage: createMigratingStorage(renamed as unknown as CollectionsDef, durable),
    registry: compileIndexRegistry(renamed),
  });
  expect(optimizeCount).toBe(2);

  const names = backing.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'takibi_idx_%'`,
    )
    .toArray()
    .map((row) => row.name);
  expect(names).toEqual([physicalIndexName("posts", "byCreator", ["ownerId", "createdAt"])]);
  const catalog = backing.sql
    .exec<{ public_name: string }>("SELECT public_name FROM takibi_index_catalog")
    .toArray()
    .map((row) => row.public_name);
  expect(catalog).toEqual(["byCreator"]);
});

test("memory backfill and SQLite indexed order stay aligned for mixed keys", async () => {
  const collections = { posts };
  const registry = compileIndexRegistry(collections);
  const memory = createMemoryStorage(registry);
  const backing = createSqliteDurableObjectStorage();
  const durable = createDurableObjectStorage(backing, registry);
  const migratingMemory = createMigratingStorage(collections as unknown as CollectionsDef, memory);
  const migratingDurable = createMigratingStorage(
    collections as unknown as CollectionsDef,
    durable,
  );
  await backfillIndexedCollections(collections, migratingMemory);
  await reconcileCollectionIndexes({
    sql: backing.sql,
    collections,
    storage: migratingDurable,
    registry,
  });

  const docs = [
    meta({ id: "m", ownerId: "u1", createdAt: "2026-01-01T00:00:00.000Z", score: 10, label: "é" }),
    meta({ id: "n", ownerId: "u1", createdAt: "2026-01-01T00:00:00.000Z", score: 2, label: "e" }),
    meta({ id: "o", ownerId: "u1", createdAt: "2026-01-02T00:00:00.000Z", score: 2, label: "a" }),
  ];
  for (const doc of docs) {
    await migratingMemory.put("posts", doc);
    await migratingDurable.put("posts", doc);
  }

  const opts = {
    index: "byOwner",
    where: { field: "ownerId" as const, op: "eq" as const, value: "u1" },
    orderBy: { field: "createdAt", direction: "asc" as const },
  };
  const memoryPage = await memory.list("posts", opts);
  const durablePage = await durable.list("posts", opts);
  expect(memoryPage.items.map((document) => document.id)).toEqual(
    durablePage.items.map((document) => document.id),
  );
  expect(memoryPage.nextCursor).toEqual(durablePage.nextCursor);
});
