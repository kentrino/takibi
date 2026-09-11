import { expect, test } from "vite-plus/test";
import { MaintenanceLockedError } from "@takibi/api";
import type { TrustedCollectionsApi } from "@takibi/api";
import {
  attachSnapshotOperations,
  createMaintenanceGatedCollections,
  MaintenanceController,
  MemoryMaintenanceBackend,
  type SnapshotLifecycle,
} from "../src";

const lifecycle: SnapshotLifecycle = {
  listCollections() {
    return [{ name: "records", currentSchemaVersion: 0, baseSchemaVersion: 0 }];
  },
  async validateRestoredDocument() {
    return [];
  },
  async prepareSeeds() {
    return [];
  },
};

test("maintenance lock excludes normal operations until the lease is released", async () => {
  const backend = new MemoryMaintenanceBackend();
  const controller = new MaintenanceController(backend);
  const collections = createMaintenanceGatedCollections(
    {
      records: {
        async get(_id: string) {
          return { id: "ok" };
        },
      },
    } as never,
    controller,
  );

  const lease = await controller.acquire("export");
  await expect(collections.records.get("x")).rejects.toBeInstanceOf(MaintenanceLockedError);
  await controller.release(lease);
  await expect(collections.records.get("x")).resolves.toEqual({ id: "ok" });
});

test("expired in-memory lease cannot renew after the controller handle lapses", async () => {
  const backend = new MemoryMaintenanceBackend();
  const first = new MaintenanceController(backend);
  const lease = await first.acquire("export");
  lease.expiresAt = 0;

  await expect(first.renew(lease)).rejects.toBeInstanceOf(MaintenanceLockedError);
  await first.release(lease);
  const successor = new MaintenanceController(backend);
  const successorLease = await successor.acquire("reset");
  await expect(successor.renew(successorLease)).resolves.toBeUndefined();
  await successor.release(successorLease);
});

test("abandoned cleanup drops staging and the current lease", async () => {
  const backend = new MemoryMaintenanceBackend();
  const controller = new MaintenanceController(backend);
  const lease = await controller.acquire("restore");
  await backend.stageDocument(lease.token, {
    collection: "records",
    id: "abandoned",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 1,
    data: { value: "abandoned" },
  });

  await controller.cleanupAbandoned();
  await expect(backend.hasStagedDocument(lease.token, "records", "abandoned")).resolves.toBe(false);
  await expect(controller.acquire("reset")).resolves.toMatchObject({ purpose: "reset" });
});

test("export failure and cancellation release the maintenance lease", async () => {
  const failureBackend = new MemoryMaintenanceBackend();
  failureBackend.writeLive({
    collection: "unknown",
    id: "hidden",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 1,
    data: { value: "hidden" },
  });
  const failureController = new MaintenanceController(failureBackend);
  const failureApi = attachSnapshotOperations(
    {} as TrustedCollectionsApi<{ records: never }>,
    failureController,
    Promise.resolve(),
    lifecycle,
  );
  await expect(new Response(await failureApi.$exportSnapshot()).text()).rejects.toMatchObject({
    code: "SNAPSHOT_INCOMPATIBLE",
  });
  await expect(failureController.acquire("reset")).resolves.toMatchObject({ purpose: "reset" });

  const cancelBackend = new MemoryMaintenanceBackend();
  cancelBackend.writeLive({
    collection: "records",
    id: "r1",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 1,
    data: { value: "keep" },
  });
  const cancelController = new MaintenanceController(cancelBackend);
  const cancelApi = attachSnapshotOperations(
    {} as TrustedCollectionsApi<{ records: never }>,
    cancelController,
    Promise.resolve(),
    lifecycle,
  );
  const stream = await cancelApi.$exportSnapshot();
  await stream.cancel();
  await expect(cancelController.acquire("reset")).resolves.toMatchObject({ purpose: "reset" });
});

test("drain waits for in-flight normal work before admitting maintenance", async () => {
  const backend = new MemoryMaintenanceBackend();
  const controller = new MaintenanceController(backend);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = controller.runNormal(async () => {
    await held;
    return "done";
  });
  let admitted = false;
  const acquire = controller.acquire("export").then((lease) => {
    admitted = true;
    return lease;
  });

  await Promise.resolve();
  expect(admitted).toBe(false);
  release();
  await expect(running).resolves.toBe("done");
  const lease = await acquire;
  expect(admitted).toBe(true);
  await controller.release(lease);
});
