import { expect, test } from "vite-plus/test";
import * as SnapshotPkg from "@takibi/snapshot";
import * as RuntimePkg from "@takibi/worker-runtime";
import * as MaintenanceFacade from "../src/maintenance";
import * as MaintenanceMemoryFacade from "../src/maintenance-memory";
import * as SnapshotFacade from "../src/snapshot";

test("Takibi snapshot modules re-export the owner package bindings", () => {
  expect(MaintenanceFacade.MaintenanceController).toBe(SnapshotPkg.MaintenanceController);
  expect(MaintenanceFacade.SqliteMaintenanceBackend).toBe(SnapshotPkg.SqliteMaintenanceBackend);
  expect(MaintenanceFacade.initializeMaintenanceLayout).toBe(
    SnapshotPkg.initializeMaintenanceLayout,
  );
  expect(MaintenanceFacade.createMaintenanceGatedCollections).toBe(
    SnapshotPkg.createMaintenanceGatedCollections,
  );
  expect(MaintenanceMemoryFacade.MemoryMaintenanceBackend).toBe(
    SnapshotPkg.MemoryMaintenanceBackend,
  );
  expect(SnapshotFacade.createDurableObjectCollectionsApi).toBe(
    RuntimePkg.createDurableObjectCollectionsApi,
  );
  expect(SnapshotFacade.createTakibiSnapshotLifecycle).toBe(
    RuntimePkg.createTakibiSnapshotLifecycle,
  );
});
