import { expect, test } from "vite-plus/test";
import { compileWhere, matchesQuery, normalizeQueryExpr, queryImpliesEquality } from "../src/query";
import type { QueryBuilder, QueryExpr } from "../src/types";

type Item = {
  ownerId: string;
  status?: string;
  score: number;
  active: boolean;
  nullable: string | null;
};

test("query builder compiles immutable recursive expressions", () => {
  let calls = 0;
  const where = compileWhere<Item>((query) => {
    calls += 1;
    return query.and(
      query.ownerId.eq("u1"),
      query.or(query.score.gte(10), query.not(query.active.eq(true))),
    );
  });

  expect(calls).toBe(1);
  expect(where).toEqual({
    op: "and",
    operands: [
      { field: "ownerId", op: "eq", value: "u1" },
      {
        op: "or",
        operands: [
          { field: "score", op: "gte", value: 10 },
          { op: "not", operand: { field: "active", op: "eq", value: true } },
        ],
      },
    ],
  });
  expect(Object.isFrozen(where)).toBe(true);
  expect(Object.isFrozen("operands" in where ? where.operands : [])).toBe(true);
});

test("query builder rejects missing, foreign, and invalid expressions", () => {
  expect(() => compileWhere<Item>(() => undefined as never)).toThrow(TypeError);
  expect(() =>
    compileWhere<Item>(() => ({ field: "ownerId", op: "eq", value: "u1" }) as QueryExpr),
  ).toThrow(/query builder/);
  expect(() =>
    compileWhere<Item>((query) =>
      query.and(query.ownerId.eq("u1"), { field: "status", op: "eq", value: "open" } as QueryExpr),
    ),
  ).toThrow(/current query builder/);
  expect(() =>
    compileWhere<Item>((query) =>
      (query.score.eq as (value: unknown) => QueryExpr)(Number.POSITIVE_INFINITY),
    ),
  ).toThrow(/finite/);
  expect(() =>
    compileWhere<Item>((query) =>
      (
        query.active as unknown as {
          gte(value: unknown): QueryExpr;
        }
      ).gte(true),
    ),
  ).toThrow(/string or finite number/);
});

test("normalization validates exact shape, scalar values, arity, size, and depth", () => {
  expect(() => normalizeQueryExpr({ field: "score", op: "wat", value: 1 })).toThrow(/operator/);
  expect(() => normalizeQueryExpr({ field: "score", op: "eq", value: { nested: true } })).toThrow(
    /scalar/,
  );
  expect(() => normalizeQueryExpr({ field: "score", op: "eq", value: Number.NaN })).toThrow(
    /finite/,
  );
  expect(() => normalizeQueryExpr({ field: "score", op: "eq", value: 1, extra: true })).toThrow(
    /unexpected/,
  );
  expect(() =>
    normalizeQueryExpr({
      op: "and",
      operands: [{ field: "score", op: "eq", value: 1 }],
    }),
  ).toThrow(/two operands/);

  const leaf = { field: "score", op: "eq", value: 1 };
  expect(() =>
    normalizeQueryExpr({ op: "and", operands: Array.from({ length: 32 }, () => leaf) }),
  ).toThrow(/32 nodes/);

  let deep: unknown = leaf;
  for (let index = 0; index < 8; index += 1) deep = { op: "not", operand: deep };
  expect(() => normalizeQueryExpr(deep)).toThrow(/depth/);
});

test("query evaluation uses strict scalar types and ordinary boolean logic", () => {
  const document = {
    ownerId: "u1",
    score: 10,
    active: false,
    nullable: null,
  };
  const compile = (callback: (query: QueryBuilder<Item>) => QueryExpr) =>
    compileWhere<Item>(callback);

  expect(
    matchesQuery(
      document,
      compile((query) => query.score.gte(10)),
    ),
  ).toBe(true);
  expect(
    matchesQuery(
      document,
      compile((query) => query.ownerId.lt("u2")),
    ),
  ).toBe(true);
  expect(
    matchesQuery(
      document,
      compile((query) => query.nullable.eq(null)),
    ),
  ).toBe(true);
  expect(
    matchesQuery(
      document,
      compile((query) => query.status.eq("open")),
    ),
  ).toBe(false);
  expect(
    matchesQuery(
      document,
      compile((query) => query.not(query.status.eq("open"))),
    ),
  ).toBe(true);
  expect(
    matchesQuery(
      { ...document, score: "10" },
      compile((query) => query.score.eq(10)),
    ),
  ).toBe(false);
});

test("owner equality implication is conservative across boolean structure", () => {
  const compile = (callback: (query: QueryBuilder<Item>) => QueryExpr) =>
    compileWhere<Item>(callback);
  const owner = compile((query) => query.ownerId.eq("u1"));
  const andOwner = compile((query) => query.and(query.ownerId.eq("u1"), query.status.eq("open")));
  const orOwner = compile((query) => query.or(query.ownerId.eq("u1"), query.status.eq("public")));
  const orBoth = compile((query) =>
    query.or(
      query.and(query.ownerId.eq("u1"), query.status.eq("open")),
      query.and(query.ownerId.eq("u1"), query.status.eq("closed")),
    ),
  );
  const negated = compile((query) => query.not(query.ownerId.eq("u2")));

  expect(queryImpliesEquality(owner, "ownerId", "u1")).toBe(true);
  expect(queryImpliesEquality(andOwner, "ownerId", "u1")).toBe(true);
  expect(queryImpliesEquality(orOwner, "ownerId", "u1")).toBe(false);
  expect(queryImpliesEquality(orBoth, "ownerId", "u1")).toBe(true);
  expect(queryImpliesEquality(negated, "ownerId", "u1")).toBe(false);
  expect(queryImpliesEquality(undefined, "ownerId", "u1")).toBe(false);
});
