import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { ActionRegistry, createRootActionBuilder, type RootActionArgs } from "../src/action";
import { executeAction } from "../src/action-executor";
import { fullAccess, none } from "../src/policy";
import { createDurableObjectStorage } from "../src/storage";
import { createSqliteDurableObjectStorage } from "../src/testing/sqlite-storage.server";
import type { CollectionsDef, StorageDriver, StoredDocument } from "../src/types";

const TS = "2026-08-19T00:00:00.000Z";

function document(id: string, value: string): StoredDocument {
  return { id, value, createdAt: TS, updatedAt: TS, rev: 1 };
}

function createStorage() {
  return createDurableObjectStorage(createSqliteDurableObjectStorage());
}

test("SQLite transactions commit, roll back, and join nested transactions", async () => {
  const storage = createStorage();
  await storage.put("items", document("existing", "before"));

  await storage.transaction(async (scoped) => {
    await scoped.put("items", document("atomic", "committed"));
    await scoped.transaction(async (nested) => {
      await nested.put("items", document("nested", "committed"));
    });
  });

  await expect(storage.get("items", "atomic")).resolves.toEqual(document("atomic", "committed"));
  await expect(storage.get("items", "nested")).resolves.toEqual(document("nested", "committed"));

  await expect(
    storage.transaction(async (scoped) => {
      await scoped.put("items", document("rolled-back", "no"));
      await scoped.delete("items", "existing");
      await scoped.transaction(async (nested) => {
        await nested.put("items", document("nested-rolled-back", "no"));
      });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await expect(storage.get("items", "rolled-back")).resolves.toBeNull();
  await expect(storage.get("items", "nested-rolled-back")).resolves.toBeNull();
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
  const raw = createStorage();
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
  const denied = createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
    .atomic()
    .policy(({ ctx }) => (ctx.allowed ? fullAccess : none))
    .handler(() => {
      handlerCalls += 1;
      return null;
    });
  const validated = createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
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
  const action = createRootActionBuilder<object, RootActionArgs<object, {}>>()
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
