import { compileWhere } from "@takibi/takibi-query";
import { expect, test } from "vite-plus/test";
import {
  assertCollectionIndexes,
  compareIndexTuple,
  compareUtf8,
  compileIndexRegistry,
  impliedEqualityValue,
  planIndexRange,
  resolveIndexedList,
  type IndexRangePlan,
} from "../src";

test("assertCollectionIndexes rejects empty, duplicate, and reserved fields", () => {
  expect(() =>
    assertCollectionIndexes({ indexes: { empty: [] as never } } as never, "posts"),
  ).toThrow(/non-empty tuple/);
  expect(() =>
    assertCollectionIndexes(
      { indexes: { duplicate: ["ownerId", "ownerId"] as never } } as never,
      "posts",
    ),
  ).toThrow(/repeats field/);
  expect(() =>
    assertCollectionIndexes({ indexes: { reserved: ["rev"] as never } } as never, "posts"),
  ).toThrow(/reserved field/);
  expect(() =>
    assertCollectionIndexes(
      { indexes: { reserved: ["$schemaVersion"] as never } } as never,
      "posts",
    ),
  ).toThrow(/reserved field/);
});

test("planner extracts equality prefix and a single range field", () => {
  const where = compileWhere<{ ownerId: string; createdAt: string; tag: string }>((query) =>
    query.and(query.ownerId.eq("u1"), query.createdAt.gte("2026-01-01"), query.tag.eq("x")),
  );
  expect(impliedEqualityValue(where, "ownerId")).toBe("u1");
  expect(planIndexRange(["ownerId", "createdAt"], where)).toEqual({
    equalities: [{ field: "ownerId", value: "u1" }],
    rangeField: "createdAt",
    range: { gte: "2026-01-01" },
  });
});

test("range bounds require a field, but equality-only and unbounded plans remain valid", () => {
  // @ts-expect-error bounds without a field would be silently ignored by index scans
  const invalid: IndexRangePlan = { equalities: [], range: { gte: 1 } };
  void invalid;

  const equalityOnly: IndexRangePlan = { equalities: [{ field: "ownerId", value: "u1" }] };
  const unbounded: IndexRangePlan = { equalities: [], rangeField: "createdAt" };
  expect(planIndexRange(["ownerId"], { field: "ownerId", op: "eq", value: "u1" })).toEqual(
    equalityOnly,
  );
  expect(planIndexRange(["createdAt"], undefined)).toEqual(unbounded);
  expect(planIndexRange([], undefined)).toEqual({ equalities: [] });
});

test("resolveIndexedList rejects unknown indexes and missing equality prefix", () => {
  const registry = compileIndexRegistry({
    posts: {
      indexes: { byOwner: ["ownerId", "createdAt"] as const },
    },
  });
  expect(() => resolveIndexedList("posts", { index: "missing" }, registry)).toThrow(
    /Unknown index/,
  );
  expect(() =>
    resolveIndexedList(
      "posts",
      {
        index: "byOwner",
        orderBy: { field: "createdAt", direction: "desc" },
      },
      registry,
    ),
  ).toThrow(/requires equality on ownerId/);
  expect(
    resolveIndexedList(
      "posts",
      {
        index: "byOwner",
        where: { field: "ownerId", op: "eq", value: "u1" },
        orderBy: { field: "createdAt", direction: "desc" },
      },
      registry,
    ),
  ).toMatchObject({
    orderField: "createdAt",
    direction: "desc",
  });
});

test("UTF-8 byte order matches SQLite BINARY for non-ASCII strings", () => {
  expect(compareUtf8("a", "b")).toBeLessThan(0);
  expect(compareUtf8("é", "e")).toBeGreaterThan(0);
  expect(compareIndexTuple([1, "a"], [1, "b"], "asc")).toBeLessThan(0);
  expect(compareIndexTuple([1, "a"], [1, "b"], "desc")).toBeGreaterThan(0);
});
