import { expectTypeOf, test } from "vite-plus/test";
import type { ListOptions, QueryBuilder, QueryExpr, QueryField } from "../src";

type Item = {
  ownerId: string;
  status?: string;
  score: number;
  active: boolean;
  nullable: string | null;
  mixed: string | number;
  rev: number;
  $schemaVersion: number;
};

test("query fields keep exact scalar typing and reject invalid operators", () => {
  const check = (query: QueryBuilder<Item>) => {
    const owner: QueryExpr = query.ownerId.eq("u1");
    const score: QueryExpr = query.score.gte(10);
    const active: QueryExpr = query.active.eq(true);
    const nullable: QueryExpr = query.nullable.eq(null);
    const optional: QueryExpr = query.status.eq("open");
    const present: QueryExpr = query.status.present();
    void owner;
    void score;
    void active;
    void nullable;
    void optional;
    void present;

    expectTypeOf<QueryField<string>["eq"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<QueryField<number>["eq"]>().parameter(0).toEqualTypeOf<number>();
    expectTypeOf<QueryField<boolean>["eq"]>().parameter(0).toEqualTypeOf<boolean>();
    expectTypeOf<QueryField<string | null>["eq"]>().parameter(0).toEqualTypeOf<string | null>();
    expectTypeOf<QueryBuilder<Item>>().not.toHaveProperty("rev");
    expectTypeOf<QueryBuilder<Item>>().not.toHaveProperty("$schemaVersion");

    // @ts-expect-error unknown fields are not queryable
    query.missing.eq("value");
    // @ts-expect-error booleans only support equality
    query.active.gte(true);
    // @ts-expect-error equality values follow the schema output type
    query.ownerId.eq(42);
    // @ts-expect-error string matching is only available on string fields
    query.active.contains("true");
    query.mixed.in(["value", 1]);
    // @ts-expect-error string matching is unavailable when the field can store numbers
    query.mixed.contains("value");
  };
  void check;
});

test("ListOptions requires an index before orderBy and limits order fields", () => {
  type Indexed = ListOptions<Item, { byOwner: readonly ["ownerId", "createdAt"] }>;
  type Unindexed = ListOptions<Item>;

  const indexed: Indexed = {
    index: "byOwner",
    where: (query) => query.ownerId.eq("u1"),
    orderBy: (query) => query.ownerId.desc(),
  };
  const unindexed: Unindexed = {
    where: (query) => query.ownerId.eq("u1"),
    limit: 10,
  };
  void indexed;
  void unindexed;

  const unknownIndex: Indexed = {
    // @ts-expect-error unknown indexes are not selectable
    index: "missing",
  };
  const invalidOrder: Indexed = {
    index: "byOwner",
    orderBy: (query) =>
      // @ts-expect-error selected index fields only
      query.status.desc(),
  };
  const orderWithoutIndex: Unindexed = {
    // @ts-expect-error orderBy requires index
    orderBy: (query: { createdAt: { desc(): unknown } }) => query.createdAt.desc(),
  };
  void unknownIndex;
  void invalidOrder;
  void orderWithoutIndex;
});
