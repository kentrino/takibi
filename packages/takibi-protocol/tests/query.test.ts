import { expect, test } from "vite-plus/test";
import { normalizeQueryExpr, parseOrderBy, parseQueryExpr, TakibiProtocolError } from "../src";

test("parses JSON strings into frozen query and order ASTs", () => {
  const query = parseQueryExpr(
    JSON.stringify({
      op: "and",
      operands: [
        { field: "clinicId", op: "eq", value: "clinic-a" },
        { field: "createdAt", op: "gte", value: "2026-09-01" },
      ],
    }),
  );
  const orderBy = parseOrderBy('{"field":"createdAt","direction":"desc"}');

  expect(query).toEqual({
    op: "and",
    operands: [
      { field: "clinicId", op: "eq", value: "clinic-a" },
      { field: "createdAt", op: "gte", value: "2026-09-01" },
    ],
  });
  expect(Object.isFrozen(query)).toBe(true);
  expect(orderBy).toEqual({ field: "createdAt", direction: "desc" });
  expect(Object.isFrozen(orderBy)).toBe(true);
});

test("rejects invalid JSON and malformed AST values", () => {
  expect(() => parseQueryExpr("{")).toThrow(TakibiProtocolError);
  expect(() => normalizeQueryExpr({ field: "clinicId", op: "eq", value: ["clinic-a"] })).toThrow(
    /JSON scalar/,
  );
  expect(() => parseOrderBy('{"field":"createdAt","direction":"sideways"}')).toThrow(/asc or desc/);
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
  expect(() => normalizeQueryExpr({ field: "status", op: "present", value: "unexpected" })).toThrow(
    /unexpected/,
  );
});
