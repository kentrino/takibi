import { expect, test } from "vite-plus/test";
import { queryImpliesEquality } from "../src/index";
import {
  compileListOptions,
  compileWhere,
  matchesQuery,
  normalizeQueryExpr,
  queryImpliesEquality as queryImpliesEqualityCompat,
} from "../src/query";
import type { QueryBuilder, QueryExpr } from "../src/types";

type Item = {
  ownerId: string;
  status?: string;
  score: number;
};

test("public root still exports queryImpliesEquality", () => {
  const where = compileWhere<Item>((query) => query.ownerId.eq("u1"));
  expect(queryImpliesEquality(where, "ownerId", "u1")).toBe(true);
  expect(queryImpliesEqualityCompat(where, "ownerId", "u1")).toBe(true);
});

test("compatibility query module still compiles and evaluates where clauses", () => {
  const where = compileWhere<Item>((query: QueryBuilder<Item>) =>
    query.and(query.ownerId.eq("u1"), query.status.eq("open")),
  );
  expect(where).toEqual({
    op: "and",
    operands: [
      { field: "ownerId", op: "eq", value: "u1" },
      { field: "status", op: "eq", value: "open" },
    ],
  });
  expect(matchesQuery({ ownerId: "u1", status: "open", score: 1 }, where)).toBe(true);
  expect(
    compileListOptions({
      where: (query: QueryBuilder<Item>) => query.ownerId.eq("u1"),
      limit: 10,
    }),
  ).toEqual({
    where: { field: "ownerId", op: "eq", value: "u1" },
    limit: 10,
  });
});

test("compatibility query module still re-exports protocol normalization", () => {
  expect(() => normalizeQueryExpr({ field: "score", op: "eq", value: { nested: true } })).toThrow(
    /scalar/,
  );
  const expr: QueryExpr = { field: "score", op: "eq", value: 1 };
  expect(normalizeQueryExpr(expr)).toEqual(expr);
});
