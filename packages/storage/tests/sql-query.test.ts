import { expect, test } from "vite-plus/test";
import { compileQueryToSql } from "@takibi/storage";

test("SQL lowering parameterizes values and rejects interpolation", () => {
  const attack = "' OR 1=1 --";
  const compiled = compileQueryToSql({ field: "title", op: "eq", value: attack });
  expect(compiled.sql).not.toContain(attack);
  expect(compiled.sql).toContain("?");
  expect(compiled.bindings).toEqual(["title", attack]);
});

test("SQL lowering uses metadata columns for id and timestamps", () => {
  const compiled = compileQueryToSql({ field: "id", op: "gte", value: "c" });
  expect(compiled.sql).toContain("(id >=");
  expect(compiled.sql).not.toContain("json_each");
  expect(compiled.bindings).toEqual(["c"]);
});

test("negated approximate string ranges stay an unrestricted candidate", () => {
  const negated = compileQueryToSql({
    op: "not",
    operand: { field: "label", op: "lt", value: "\uE000" },
  });
  expect(negated).toEqual({ sql: "1", bindings: [], exact: false });

  const metadata = compileQueryToSql({
    op: "not",
    operand: { field: "id", op: "lt", value: "\uE000" },
  });
  expect(metadata).toEqual({ sql: "1", bindings: [], exact: false });

  const nested = compileQueryToSql({
    op: "not",
    operand: {
      op: "and",
      operands: [
        { field: "owner", op: "eq", value: "u1" },
        { field: "label", op: "lt", value: "\uE000" },
      ],
    },
  });
  expect(nested).toEqual({ sql: "1", bindings: [], exact: false });
});

test("boolean composition keeps exact bounds when negating an approximate predicate", () => {
  const composed = compileQueryToSql({
    op: "and",
    operands: [
      { field: "owner", op: "eq", value: "u1" },
      { op: "not", operand: { field: "label", op: "lt", value: "\uE000" } },
    ],
  });
  expect(composed.sql).toContain("= ?");
  expect(composed.sql).not.toContain("NOT");
  expect(composed.bindings).toEqual(["owner", "u1"]);
  expect(composed.exact).toBe(false);

  const numeric = compileQueryToSql({ field: "score", op: "lt", value: 20 });
  expect(numeric.sql).toContain("takibi_field.atom < ?");
  expect(numeric.bindings).toEqual(["score", 20]);
  expect(numeric.exact).toBe(true);

  const ascii = compileQueryToSql({
    op: "not",
    operand: { field: "label", op: "gte", value: "m" },
  });
  expect(ascii.sql).toContain("NOT");
  expect(ascii.sql).toContain(">= ?");
  expect(ascii.bindings).toEqual(["label", "m"]);
  expect(ascii.exact).toBe(true);
});

test("SQL lowering encodes null, boolean, and string operators as predicates", () => {
  expect(compileQueryToSql({ field: "nullable", op: "eq", value: null })).toMatchObject({
    sql: expect.stringContaining("takibi_field.type = 'null'"),
    bindings: ["nullable"],
  });
  expect(compileQueryToSql({ field: "active", op: "eq", value: true })).toMatchObject({
    sql: expect.stringContaining("takibi_field.type = 'true'"),
    bindings: ["active"],
  });
  const contains = compileQueryToSql({ field: "owner", op: "contains", value: "u" });
  expect(contains.sql).toContain("instr(");
  expect(contains.bindings).toEqual(["owner", "u"]);
});
