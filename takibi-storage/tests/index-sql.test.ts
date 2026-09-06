import { expect, test } from "vite-plus/test";
import {
  compileCreateIndexSql,
  compileDropIndexSql,
  compileIndexedScanSql,
  compileIndexRegistry,
  physicalIndexName,
  resolveIndexedList,
} from "../src";

test("physical index names are stable hashes of collection, public name, and fields", () => {
  const name = physicalIndexName("posts", "byOwner", ["ownerId", "createdAt"]);
  expect(name).toMatch(/^takibi_idx_[0-9a-f]{16}$/);
  expect(physicalIndexName("posts", "byOwner", ["ownerId", "createdAt"])).toBe(name);
  expect(physicalIndexName("posts", "byCreator", ["ownerId", "createdAt"])).not.toBe(name);
});

test("index DDL and scan SQL stay parameterized", () => {
  const collection = "posts";
  const fields = ["ownerId", "createdAt"] as const;
  const row = {
    physicalName: physicalIndexName(collection, "byOwner", fields),
    collection,
    publicName: "byOwner",
    fields,
    schemaVersion: 0,
  };
  const create = compileCreateIndexSql(row);
  expect(create).toContain(row.physicalName);
  expect(create).toContain("takibi_documents");
  expect(create).toContain("WHERE collection = 'posts'");
  expect(compileDropIndexSql(row.physicalName)).toBe(`DROP INDEX IF EXISTS ${row.physicalName}`);
  expect(() => compileDropIndexSql("not_a_takibi_index")).toThrow(/Invalid physical index name/);

  const registry = compileIndexRegistry({
    posts: { indexes: { byOwner: fields } },
  });
  const scan = resolveIndexedList(
    "posts",
    {
      index: "byOwner",
      where: { field: "ownerId", op: "eq", value: "u1'; DROP TABLE takibi_documents; --" },
      orderBy: { field: "createdAt", direction: "desc" },
    },
    registry,
  );
  expect(scan).toBeDefined();
  const compiled = compileIndexedScanSql("posts", scan!, { limit: 20 });
  expect(compiled.sql).not.toContain("DROP TABLE");
  expect(compiled.bindings).toContain("u1'; DROP TABLE takibi_documents; --");
  expect(compiled.bindings.at(-1)).toBe(20);
});
