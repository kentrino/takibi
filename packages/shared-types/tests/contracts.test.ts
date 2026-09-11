import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  RESERVED_DOCUMENT_DATA_KEYS,
  TAKIBI_REVISION_KEY,
  TAKIBI_VERSION_KEY,
  type ActionRequestData,
  type CollectionOperation,
  type CollectionRequestData,
  type DocumentId,
  type DocumentMetadata,
  type InvocationRequestData,
  type ObserverInvocationData,
  type QueryBuilder,
  type QueryExpr,
  type SnapshotRestoreReport,
  type StorageListOptions,
  type TakibiResult,
  type WithMetadata,
} from "@takibi/shared-types";

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

test("single-invocation request data keeps action and collection branches", () => {
  expectTypeOf<CollectionOperation>().toEqualTypeOf<
    "add" | "set" | "get" | "update" | "delete" | "list" | "count"
  >();
  expectTypeOf<ActionRequestData>().toMatchTypeOf<{
    kind: "action";
    scope: string;
    name: string;
    id?: string;
    input?: unknown;
  }>();
  expectTypeOf<CollectionRequestData>().toMatchTypeOf<{
    kind: "collection";
    collection: string;
    operation: CollectionOperation;
    id?: string;
    input?: unknown;
    list?: StorageListOptions;
  }>();
  expectTypeOf<ActionRequestData>().toExtend<InvocationRequestData>();
  expectTypeOf<CollectionRequestData>().toExtend<InvocationRequestData>();
  expectTypeOf<ObserverInvocationData>().not.toHaveProperty("input");
  expectTypeOf<Extract<ObserverInvocationData, { kind: "action" }>>().toHaveProperty("scope");
  expectTypeOf<Extract<ObserverInvocationData, { kind: "collection" }>>().toHaveProperty(
    "operation",
  );
  expectTypeOf<{ kind: "batch"; items: readonly [] }>().not.toExtend<InvocationRequestData>();
});

test("snapshot restore reports stay transport-safe leaf contracts", () => {
  expectTypeOf<SnapshotRestoreReport["formatVersion"]>().toEqualTypeOf<1>();
  expectTypeOf<SnapshotRestoreReport["documentsRestored"]>().toEqualTypeOf<number>();
  expectTypeOf<SnapshotRestoreReport["collections"]>().toEqualTypeOf<
    Record<string, { documentsRestored: number; seedsInserted: number }>
  >();
});
