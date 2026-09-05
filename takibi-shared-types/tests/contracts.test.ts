import { expectTypeOf, test } from "vite-plus/test";
import type { QueryBuilder, QueryExpr, StorageListOptions, TakibiResult } from "../src";

test("query and result contracts compose without runtime dependencies", () => {
  type Document = {
    name: string;
    score: number;
    archived: boolean;
    rev: number;
  };

  expectTypeOf<QueryBuilder<Document>["name"]["eq"]>().parameter(0).toEqualTypeOf<string>();
  expectTypeOf<QueryBuilder<Document>>().not.toHaveProperty("rev");
  expectTypeOf<StorageListOptions["where"]>().toEqualTypeOf<QueryExpr | undefined>();
  expectTypeOf<TakibiResult<{ id: string }>>().toMatchTypeOf<
    { ok: true; data: { id: string } } | { ok: false; error: unknown }
  >();
});
