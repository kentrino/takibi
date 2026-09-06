import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Storage from "../src";

test("storage package exports the SQLite engine and index planner", () => {
  expectTypeOf(Storage.createDurableObjectStorage).toBeFunction();
  expectTypeOf(Storage.compileQueryToSql).toBeFunction();
  expectTypeOf(Storage.compileIndexRegistry).toBeFunction();
  expectTypeOf(Storage.resolveIndexedList).toBeFunction();
  expectTypeOf(Storage.reconcileCollectionIndexes).toBeFunction();
  expectTypeOf(Storage.backfillIndexedCollections).toBeFunction();
  expectTypeOf(Storage.physicalIndexName).toBeFunction();
  expectTypeOf(Storage.documentRevision).toBeFunction();
  expectTypeOf(Storage.withDocumentRevision).toBeFunction();
  expectTypeOf<Storage.StorageDriver>().toHaveProperty("get");
  expectTypeOf<Storage.StorageDriver>().toHaveProperty("put");
  expectTypeOf<Storage.StorageDriver>().toHaveProperty("delete");
  expectTypeOf<Storage.StorageDriver>().toHaveProperty("list");
  expectTypeOf<Storage.StorageDriver>().toHaveProperty("transaction");
  expectTypeOf<Storage.StoredDocument>().toHaveProperty("id");
  expectTypeOf<keyof Storage.StorageDriver>().toEqualTypeOf<
    "delete" | "get" | "list" | "put" | "transaction"
  >();
  expectTypeOf(Storage).not.toHaveProperty("createTakibi");
  expectTypeOf(Storage).not.toHaveProperty("createClient");
  expectTypeOf(Storage).not.toHaveProperty("grant");
  expectTypeOf(Storage).not.toHaveProperty("nextDocumentRevision");
  expectTypeOf(Storage).not.toHaveProperty("takeRevisionPrecondition");
  expectTypeOf(Storage).not.toHaveProperty("assertRevisionPrecondition");
  expectTypeOf(Storage).not.toHaveProperty("createMigratingStorage");
  expectTypeOf(Storage).not.toHaveProperty("initializeMaintenanceLayout");
  expect(Storage.documentRevision({ rev: 4 })).toBe(4);
  expect(Storage.physicalIndexName("posts", "byOwner", ["ownerId"])).toMatch(
    /^takibi_idx_[0-9a-f]+$/,
  );
});
