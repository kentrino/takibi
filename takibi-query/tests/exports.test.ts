import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Query from "../src";

test("query package exports construction, evaluation, and list options", () => {
  expectTypeOf(Query.compileWhere).toBeFunction();
  expectTypeOf(Query.compileOrderBy).toBeFunction();
  expectTypeOf(Query.compileListOptions).toBeFunction();
  expectTypeOf(Query.matchesQuery).toBeFunction();
  expectTypeOf(Query.queryImpliesEquality).toBeFunction();
  expectTypeOf<Query.ListOptions<{ ownerId: string }>>().toHaveProperty("where");
  expectTypeOf<Query.QueryBuilder<{ ownerId: string }>>().toHaveProperty("ownerId");
  expectTypeOf<Query.QueryField<string>>().toHaveProperty("eq");
  expectTypeOf<Query.QueryExpr>().not.toBeNever();
  expectTypeOf(Query).not.toHaveProperty("normalizeQueryExpr");
  expectTypeOf(Query).not.toHaveProperty("normalizeOrderBy");
  expectTypeOf(Query).not.toHaveProperty("parseQueryExpr");
  expectTypeOf(Query).not.toHaveProperty("parseOrderBy");
  expectTypeOf(Query).not.toHaveProperty("QUERY_MAX_NODES");
  expectTypeOf(Query).not.toHaveProperty("compileQueryToSql");
  expect(Query.compileWhere<{ ownerId: string }>((query) => query.ownerId.eq("u1"))).toEqual({
    field: "ownerId",
    op: "eq",
    value: "u1",
  });
});
