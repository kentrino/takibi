import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { ActionRegistry, createActionBuilder, type RootActionArgs } from "../src/action";
import { executeAction } from "../src/action-executor";
import { fullAccess, none } from "../src/policy";
import { createMemoryStorage } from "../src/storage";
import type { CollectionsDef, StorageDriver, StoredDocument } from "../src/types";

const TS = "2026-08-19T00:00:00.000Z";

function document(id: string, value: string): StoredDocument {
  return { id, value, createdAt: TS, updatedAt: TS, rev: 1 };
}

test("memory transactions commit, rollback, and serialize concurrent writes", async () => {
  const storage = createMemoryStorage();
  await storage.put("items", document("existing", "before"));

  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = storage.transaction(async (scoped) => {
    await scoped.put("items", document("atomic", "committed"));
    enter();
    await released;
  });
  await entered;

  let concurrentCompleted = false;
  const concurrent = storage.put("items", document("concurrent", "preserved")).then(() => {
    concurrentCompleted = true;
  });
  await Promise.resolve();
  expect(concurrentCompleted).toBe(false);
  release();
  await Promise.all([transaction, concurrent]);

  await expect(storage.get("items", "atomic")).resolves.toEqual(document("atomic", "committed"));
  await expect(storage.get("items", "concurrent")).resolves.toEqual(
    document("concurrent", "preserved"),
  );

  await expect(
    storage.transaction(async (scoped) => {
      await scoped.put("items", document("rolled-back", "no"));
      await scoped.delete("items", "existing");
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await expect(storage.get("items", "rolled-back")).resolves.toBeNull();
  await expect(storage.get("items", "existing")).resolves.toEqual(document("existing", "before"));
});

test("policy and input failures happen before an atomic transaction or handler", async () => {
  type Ctx = { allowed: boolean };
  const collections = {
    items: {
      schema: z.object({ value: z.string() }),
      accessPolicy: fullAccess,
    },
  } satisfies CollectionsDef<Ctx>;
  const raw = createMemoryStorage();
  let transactions = 0;
  const storage: StorageDriver = {
    ...raw,
    transaction(callback) {
      transactions += 1;
      return raw.transaction(callback);
    },
  };
  let handlerCalls = 0;
  const registry = new ActionRegistry();
  const denied = createActionBuilder<Ctx, "root", RootActionArgs<Ctx, typeof collections>>("root")
    .atomic()
    .policy(({ ctx }) => (ctx.allowed ? fullAccess : none))
    .handler(() => {
      handlerCalls += 1;
      return null;
    });
  const validated = createActionBuilder<Ctx, "root", RootActionArgs<Ctx, typeof collections>>(
    "root",
  )
    .input(z.object({ value: z.string().min(1) }))
    .atomic()
    .policy(fullAccess)
    .handler(() => {
      handlerCalls += 1;
      return null;
    });
  registry.registerRootActions({ denied, validated }, new Set(["items"]));

  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { allowed: false },
      {
        kind: "action",
        scope: "$",
        name: "denied",
      },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { allowed: true },
      {
        kind: "action",
        scope: "$",
        name: "validated",
        input: { value: "" },
      },
    ),
  ).rejects.toThrow();
  expect(transactions).toBe(0);
  expect(handlerCalls).toBe(0);
});

test("atomic is idempotent and retained by the runtime registry", () => {
  const action = createActionBuilder<object, "root", RootActionArgs<object, {}>>("root")
    .atomic()
    .atomic()
    .policy(fullAccess)
    .atomic()
    .handler(() => ({ ok: true }));
  const registry = new ActionRegistry();
  registry.registerRootActions({ action }, new Set());

  expect(action.atomic).toBe(true);
  expect(registry.get("$", "action")?.definition.atomic).toBe(true);
});
