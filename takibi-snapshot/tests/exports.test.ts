import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Snapshot from "../src";

test("snapshot package exports maintenance coordination and snapshot streaming", () => {
  expectTypeOf(Snapshot.attachSnapshotOperations).toBeFunction();
  expectTypeOf(Snapshot.MaintenanceController).toBeConstructibleWith(
    {} as Snapshot.MaintenanceBackend,
  );
  expectTypeOf(Snapshot.MemoryMaintenanceBackend).toBeConstructibleWith();
  expectTypeOf(Snapshot.SqliteMaintenanceBackend).toBeConstructibleWith({} as DurableObjectStorage);
  expectTypeOf(Snapshot.initializeMaintenanceLayout).toBeFunction();
  expectTypeOf(Snapshot.createMaintenanceGatedCollections).toBeFunction();
  expectTypeOf<Snapshot.SnapshotStoredDocument>().toHaveProperty("collection");
  expectTypeOf<Snapshot.SnapshotLifecycle>().toHaveProperty("listCollections");
  expectTypeOf<Snapshot.SnapshotRestoreReport>().toHaveProperty("documentsRestored");
  expectTypeOf(Snapshot).not.toHaveProperty("createTakibi");
  expectTypeOf(Snapshot).not.toHaveProperty("createClient");
  expectTypeOf(Snapshot).not.toHaveProperty("createDurableObjectCollectionsApi");
  expectTypeOf(Snapshot).not.toHaveProperty("createMigratingStorage");
  expectTypeOf(Snapshot).not.toHaveProperty("prepareAddDoc");
  expectTypeOf(Snapshot).not.toHaveProperty("validateStoredDocumentForRestore");
  expect(new Snapshot.MemoryMaintenanceBackend().readLive("records", "missing")).toBeUndefined();
});
