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
