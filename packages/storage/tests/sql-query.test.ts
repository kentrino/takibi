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
