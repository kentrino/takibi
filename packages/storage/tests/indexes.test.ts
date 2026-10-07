import { compileWhere } from "@takibi/query";
import { expect, test } from "vite-plus/test";
import {
  assertCollectionIndexes,
  compareIndexTuple,
  compareUtf8,
  compileIndexRegistry,
  impliedEqualityValue,
  matchesIndexRange,
  planIndexRange,
  resolveIndexedList,
  type IndexRangePlan,
} from "@takibi/storage";

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

test("combined string bounds use JavaScript order", () => {
  const lower = compileWhere<{ label: string }>((query) =>
    query.and(
      query.label.gt("b"),
      query.label.gt("a"),
      query.label.gt("\uE000"),
      query.label.gt("😀"),
    ),
  );
  expect(planIndexRange(["label"], lower)).toEqual({
    equalities: [],
    rangeField: "label",
    range: { gt: "\uE000" },
  });

  const upper = compileWhere<{ label: string }>((query) =>
    query.and(query.label.lt("b"), query.label.lt("a")),
  );
  expect(planIndexRange(["label"], upper)).toEqual({
    equalities: [],
    rangeField: "label",
    range: { lt: "a" },
  });

  const numeric = compileWhere<{ score: number }>((query) =>
    query.and(query.score.gt(1), query.score.gt(10), query.score.lte(20)),
  );
  expect(planIndexRange(["score"], numeric)).toEqual({
    equalities: [],
    rangeField: "score",
    range: { gt: 10, lte: 20 },
  });
});

test("index range membership follows JavaScript string order", () => {
  const range: IndexRangePlan = {
    equalities: [],
    rangeField: "label",
    range: { lt: "\uE000" },
  };
  expect(matchesIndexRange({ label: "😀" }, range)).toBe(true);
  expect(matchesIndexRange({ label: "\uE000" }, range)).toBe(false);
  expect(matchesIndexRange({ label: "a" }, range)).toBe(true);
  expect(
    matchesIndexRange({ score: 11 }, { equalities: [], rangeField: "score", range: { gt: 10 } }),
  ).toBe(true);
  expect(
    matchesIndexRange({ score: 10 }, { equalities: [], rangeField: "score", range: { gt: 10 } }),
  ).toBe(false);
});

test("UTF-8 byte order matches SQLite BINARY for non-ASCII strings", () => {
  expect(compareUtf8("a", "b")).toBeLessThan(0);
  expect(compareUtf8("é", "e")).toBeGreaterThan(0);
  expect(compareIndexTuple([1, "a"], [1, "b"], "asc")).toBeLessThan(0);
  expect(compareIndexTuple([1, "a"], [1, "b"], "desc")).toBeGreaterThan(0);
});
