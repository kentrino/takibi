import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  RESERVED_DOCUMENT_DATA_KEYS,
  TAKIBI_REVISION_KEY,
  TAKIBI_VERSION_KEY,
  type DocumentId,
  type DocumentMetadata,
  type QueryBuilder,
  type QueryExpr,
  type StorageListOptions,
  type TakibiResult,
  type WithMetadata,
} from "../src";

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

test("document identity and metadata contracts stay transport-safe", () => {
  expectTypeOf<DocumentId>().toEqualTypeOf<string>();
  expectTypeOf<DocumentMetadata["id"]>().toEqualTypeOf<DocumentId>();
  expectTypeOf<WithMetadata<{ title: string; id: number }>>().toMatchTypeOf<{
    id: DocumentId;
    title: string;
    createdAt: string;
    updatedAt: string;
  }>();
  expect(TAKIBI_VERSION_KEY).toBe("$schemaVersion");
  expect(TAKIBI_REVISION_KEY).toBe("rev");
  expect(RESERVED_DOCUMENT_DATA_KEYS).toEqual([
    "id",
    "createdAt",
    "updatedAt",
    "$schemaVersion",
    "rev",
  ]);
});
