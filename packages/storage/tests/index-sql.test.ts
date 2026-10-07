import { expect, test } from "vite-plus/test";
import {
  compileCreateIndexSql,
  compileDropIndexSql,
  compileIndexedScanSql,
  compileIndexRegistry,
  physicalIndexName,
  resolveIndexedList,
} from "@takibi/storage";

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

test("indexed scans keep equality prefixes and numeric bounds but not unsafe string bounds", () => {
  const registry = compileIndexRegistry({
    posts: {
      indexes: {
        byLabel: ["label"] as const,
        byOwner: ["ownerId", "label"] as const,
        byScore: ["score"] as const,
      },
    },
  });
  const unsafe = resolveIndexedList(
    "posts",
    { index: "byLabel", where: { field: "label", op: "lt", value: "\uE000" } },
    registry,
  );
  const unsafeSql = compileIndexedScanSql("posts", unsafe!, { limit: 10 });
  expect(unsafeSql.bindings).not.toContain("\uE000");
  expect(unsafeSql.sql).not.toContain("< ?");

  const ascii = resolveIndexedList(
    "posts",
    { index: "byLabel", where: { field: "label", op: "gte", value: "m" } },
    registry,
  );
  const asciiSql = compileIndexedScanSql("posts", ascii!, { limit: 10 });
  expect(asciiSql.sql).toContain(">= ?");
  expect(asciiSql.bindings).toContain("m");

  const prefixed = resolveIndexedList(
    "posts",
    {
      index: "byOwner",
      where: {
        op: "and",
        operands: [
          { field: "ownerId", op: "eq", value: "u1" },
          { field: "label", op: "lt", value: "\uE000" },
        ],
      },
      orderBy: { field: "label", direction: "asc" },
    },
    registry,
  );
  const prefixedSql = compileIndexedScanSql("posts", prefixed!, { limit: 10 });
  expect(prefixedSql.sql).toContain("= ?");
  expect(prefixedSql.bindings).toContain("u1");
  expect(prefixedSql.bindings).not.toContain("\uE000");

  const numeric = resolveIndexedList(
    "posts",
    { index: "byScore", where: { field: "score", op: "gt", value: 15 } },
    registry,
  );
  const numericSql = compileIndexedScanSql("posts", numeric!, { limit: 10 });
  expect(numericSql.sql).toContain("> ?");
  expect(numericSql.bindings).toContain(15);
});
