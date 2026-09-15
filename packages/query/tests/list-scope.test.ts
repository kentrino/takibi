import { expect, test } from "vite-plus/test";
import { composeAnd, composeOr, isListWhereScope, listWhere, ListScopeError } from "@takibi/query";
import type { QueryExpr } from "@takibi/shared-types";

test("scope tokens require factory provenance and freeze normalized builder output", () => {
  const scope = listWhere<{ ownerId: string }>((q) => q.ownerId.eq("owner"));
  expect(isListWhereScope(scope)).toBe(true);
  expect(isListWhereScope({ ...scope })).toBe(false);
  expect(Object.isFrozen(scope)).toBe(true);
  expect(Object.isFrozen(scope.where)).toBe(true);
});

test("scope failures discard arbitrary callback errors and malformed expressions", () => {
  const invalid = [
    undefined,
    {},
    () => undefined,
    () => ({ op: "and", operands: [] }),
    () => {
      throw new Error("secret");
    },
  ];
  for (const callback of invalid) {
    expect(() => listWhere(callback as never)).toThrow("Invalid list authorization scope");
  }
});

test("server composition preserves grouping and enforces its separate budget", () => {
  const leaf = listWhere<{ id: string }>((q) => q.id.eq("a")).where;
  expect(composeAnd(leaf)).toBe(leaf);
  expect(composeOr(leaf, leaf)).toEqual({ op: "or", operands: [leaf, leaf] });
  expect(composeAnd(composeAnd(leaf, leaf), leaf)).toEqual({
    op: "and",
    operands: [{ op: "and", operands: [leaf, leaf] }, leaf],
  });
  expect(() => composeAnd()).toThrow(ListScopeError);
  expect(() => composeAnd(...Array<QueryExpr>(63).fill(leaf))).not.toThrow();
  expect(() => composeAnd(...Array<QueryExpr>(64).fill(leaf))).toThrow(ListScopeError);
  let deep = leaf;
  for (let i = 1; i < 16; i++) deep = composeAnd(deep, leaf);
  expect(() => composeAnd(deep, leaf)).toThrow(ListScopeError);
  expect(() =>
    listWhere<{ id: string }>((q) =>
      q.and(
        ...([q.id.eq("a"), q.id.eq("a"), ...Array<QueryExpr>(30).fill(q.id.eq("a"))] as [
          QueryExpr,
          QueryExpr,
          ...QueryExpr[],
        ]),
      ),
    ),
  ).toThrow(ListScopeError);
});

test("scope client depth and in-value limits remain unchanged; invalid composition fails closed", () => {
  const nested = (depth: number) =>
    listWhere<{ id: string }>((q) => {
      let result = q.id.eq("a");
      for (let i = 1; i < depth; i++) result = q.not(result);
      return result;
    });
  expect(() => nested(8)).not.toThrow();
  expect(() => nested(9)).toThrow(ListScopeError);
  expect(() =>
    listWhere<{ id: string }>((q) => q.id.in(Array<string>(32).fill("a"))),
  ).not.toThrow();
  expect(() => listWhere<{ id: string }>((q) => q.id.in(Array<string>(33).fill("a")))).toThrow(
    ListScopeError,
  );
  const cyclic: { op: "not"; operand?: unknown } = { op: "not" };
  cyclic.operand = cyclic;
  for (const invalid of [undefined, {}, { op: "or", operands: [] }, cyclic]) {
    expect(() => composeAnd(invalid as QueryExpr)).toThrow(ListScopeError);
  }
  const foreign = nested(1).where;
  expect(() => listWhere(() => foreign)).toThrow(ListScopeError);
});
