import { compileWhere } from "@takibi/query";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "../src/index";
import {
  compareIndexTuple,
  compareUtf8,
  compileIndexRegistry,
  impliedEqualityValue,
  planIndexRange,
  resolveIndexedList,
} from "../src/indexes";

const createContext = createTakibi();

test("assembly rejects empty, duplicate, and reserved index fields", () => {
  const context = createContext({
    resolve: () => ({ tenantId: "acme" }),
  });
  const schema = z.object({ ownerId: z.string(), title: z.string() });

  expect(() =>
    context.defineCollections({
      posts: {
        schema,
        accessPolicy: fullAccess,
        indexes: { empty: [] as never },
      },
    }),
  ).toThrow(/non-empty tuple/);
  expect(() =>
    context.defineCollections({
      posts: {
        schema,
        accessPolicy: fullAccess,
        indexes: { duplicate: ["ownerId", "ownerId"] as never },
      },
    }),
  ).toThrow(/repeats field/);
  expect(() =>
    context.defineCollections({
      posts: {
        schema,
        accessPolicy: fullAccess,
        indexes: { reserved: ["rev"] as never },
      },
    }),
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

test("resolveIndexedList rejects unknown indexes and missing equality prefix", () => {
  const registry = compileIndexRegistry({
    posts: {
      schema: z.object({ ownerId: z.string() }),
      accessPolicy: fullAccess,
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
