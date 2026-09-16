import { afterEach, expect, it, vi } from "vite-plus/test";
import { WatchRuntime } from "../src/watch-runtime";
import { MaintenanceController, type MaintenanceBackend } from "@takibi/snapshot";
import type { StorageDriver } from "@takibi/storage";
import type { WatchAttachment } from "@takibi/protocol";
import { executeOperation } from "../src/executor";
vi.mock("../src/executor", () => ({
  executeOperation: vi.fn(async () => ({ items: [{ id: "a" }] })),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const attachment: WatchAttachment = {
  version: 1,
  collection: "posts",
  list: { limit: 1, index: "byScore", orderBy: { field: "score", direction: "desc" } },
  context: { user: "resolved" },
};
function socket(value: unknown = JSON.stringify(attachment)) {
  return { readyState: 1, deserializeAttachment: () => value, send: vi.fn(), close: vi.fn() };
}
function fixture(sockets: ReturnType<typeof socket>[]) {
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  const pending: Promise<unknown>[] = [];
  const state = {
    getWebSockets: () => sockets,
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as unknown as DurableObjectState;
  const storage = {
    transaction: async (run: (tx: StorageDriver) => unknown) => run(storage),
  } as StorageDriver;
  const backend = {
    acquire: async () => ({ expiresAt: Date.now() + 30_000 }),
    release: async () => {},
  } as unknown as MaintenanceBackend;
  const maintenance = new MaintenanceController(backend, (purpose) =>
    runtime.maintenanceChanged(purpose),
  );
  const runtime = new WatchRuntime(state, {}, storage, maintenance, undefined);
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return { runtime, drain, maintenance };
}
it("isolates send failures and validates every recovered attachment before querying", async () => {
  const broken = socket();
  broken.send.mockImplementation(() => {
    throw new Error("send failed");
  });
  const obsolete = socket(JSON.stringify({ ...attachment, version: 0 }));
  const malformed = socket({ context: { secret: "no" } });
  const healthy = socket();
  const { runtime, drain } = fixture([broken, obsolete, malformed, healthy]);
  runtime.recover();
  await drain();
  expect(healthy.send).toHaveBeenCalledWith(
    JSON.stringify({ version: 1, kind: "snapshot", items: [{ id: "a" }] }),
  );
  expect(broken.close).toHaveBeenCalledWith(4403);
  expect(obsolete.close).toHaveBeenCalledWith(4400);
  expect(malformed.close).toHaveBeenCalledWith(4400);
  expect(executeOperation).toHaveBeenCalledTimes(2);
  expect(vi.mocked(executeOperation).mock.calls[1]![3]).toMatchObject({
    collection: "posts",
    operation: "list",
    list: attachment.list,
  });
});
it("suspends export queries and flushes pending invalidation after release", async () => {
  const healthy = socket();
  const { runtime, drain, maintenance } = fixture([healthy]);
  const lease = await maintenance.acquire("export");
  runtime.invalidate(new Set(["posts"]));
  await drain();
  expect(executeOperation).not.toHaveBeenCalled();
  await maintenance.release(lease);
  await drain();
  expect(healthy.send).toHaveBeenCalledTimes(1);
});
it.each(["restore", "reset"] as const)(
  "disconnects at %s acquisition before draining active reads",
  async (purpose) => {
    const healthy = socket();
    const { maintenance } = fixture([healthy]);
    let finish!: () => void;
    const read = maintenance.runNormal(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const acquiring = maintenance.acquire(purpose);
    expect(healthy.close).toHaveBeenCalledWith(1013);
    expect(maintenance.blocked).toBe(true);
    finish();
    await read;
    const lease = await acquiring;
    await maintenance.release(lease);
  },
);
it("does not send a snapshot if maintenance begins while policy is running", async () => {
  const healthy = socket();
  const { runtime, drain, maintenance } = fixture([healthy]);
  let resolve!: (value: { items: never[] }) => void;
  vi.mocked(executeOperation).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  runtime.invalidate(new Set(["posts"]));
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  const acquiring = maintenance.acquire("export");
  resolve({ items: [] });
  await drain();
  expect(healthy.send).not.toHaveBeenCalled();
  const lease = await acquiring;
  await maintenance.release(lease);
  await drain();
  expect(healthy.send).toHaveBeenCalledTimes(1);
});
it("flushes pending export invalidation on release even after a normal read notices lease expiry", async () => {
  const healthy = socket();
  const { runtime, drain, maintenance } = fixture([healthy]);
  const lease = await maintenance.acquire("export");
  runtime.invalidate(new Set(["posts"]));
  const now = vi.spyOn(Date, "now").mockReturnValue(lease.expiresAt + 1);
  try {
    await maintenance.runNormal(() => undefined);
    await maintenance.release(lease);
    await drain();
    expect(healthy.send).toHaveBeenCalledTimes(1);
  } finally {
    now.mockRestore();
  }
});
