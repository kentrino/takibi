import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess, none } from "takibi";
import type { WireRequest, WireResponse } from "../src/protocol";
import type { StorageTestObject } from "./worker";

const tenantId = "atomic-actions";
const externalEffects: string[] = [];
let concurrencyGate:
  | {
      entered(): void;
      released: Promise<void>;
    }
  | undefined;
const context = createTakibi()({ resolve: () => ({ tenantId }) });
const RecordSchema = z.object({ value: z.string().min(1) });
const orders = context.defineCollection({
  schema: RecordSchema,
  accessPolicy: fullAccess,
});
const app = context.defineCollections({
  orders,
  inventory: { schema: RecordSchema, accessPolicy: fullAccess },
  events: { schema: RecordSchema, accessPolicy: fullAccess },
  blocked: { schema: RecordSchema, accessPolicy: none },
});
const ordersActions = app.orders.actions((defineAction) => ({
  updateThenFail: defineAction()
    .input(z.object({ value: z.string() }))
    .atomic()
    .policy(fullAccess)
    .handler(async ({ id, input, $collection }) => {
      await $collection.update(id, { value: input.value });
      throw new Error("collection action failed");
    }),
}));
const Input = z.object({
  prefix: z.string(),
  failure: z.enum(["none", "second", "third", "storage", "handler", "policy"]),
});
const transact = app
  .defineAction()
  .input(Input)
  .atomic()
  .policy(fullAccess)
  .handler(async ({ input, collections, $collections }) => {
    await $collections.orders.add({ value: "order" }, { id: `${input.prefix}-order` });
    if (input.failure === "handler") throw new Error("handler failed");
    if (input.failure === "policy") {
      await collections.blocked.add({ value: "blocked" }, { id: `${input.prefix}-blocked` });
    }
    if (input.failure === "second") {
      await $collections.inventory.add({ value: "" }, { id: `${input.prefix}-inventory` });
    } else {
      await $collections.inventory.add({ value: "inventory" }, { id: `${input.prefix}-inventory` });
    }
    if (input.failure === "third") {
      await $collections.events.add({ value: "" }, { id: `${input.prefix}-event` });
    } else {
      await $collections.events.add({ value: "event" }, { id: `${input.prefix}-event` });
    }
    if (input.failure === "storage") {
      await $collections.events.add({ value: "duplicate" }, { id: `${input.prefix}-event` });
    }
    return { prefix: input.prefix };
  });
const invalidOutput = app
  .defineAction()
  .input(z.string())
  .atomic()
  .policy(fullAccess)
  .handler(async ({ input, $collections }) => {
    await $collections.orders.add({ value: "output" }, { id: `${input}-order` });
    const output = { ok: true };
    Object.defineProperty(output, "hidden", { value: true });
    return output;
  });
const nonAtomic = app
  .defineAction()
  .input(z.string())
  .policy(fullAccess)
  .handler(async ({ input, $collections }) => {
    await $collections.orders.add({ value: "non-atomic" }, { id: `${input}-order` });
    throw new Error("non-atomic failed");
  });
const external = app
  .defineAction()
  .input(z.string())
  .atomic()
  .policy(fullAccess)
  .handler(async ({ input, $collections }) => {
    await $collections.orders.add({ value: "external" }, { id: `${input}-order` });
    externalEffects.push(input);
    throw new Error("external failed");
  });
const waitThenFail = app
  .defineAction()
  .input(z.string())
  .atomic()
  .policy(fullAccess)
  .handler(async ({ input, $collections }) => {
    await $collections.orders.add({ value: "rolled back" }, { id: `${input}-rolled-back` });
    concurrencyGate?.entered();
    await concurrencyGate?.released;
    throw new Error("concurrent rollback");
  });
const handler = app.actions({
  $: { transact, invalidOutput, nonAtomic, external, waitThenFail },
  orders: ordersActions,
});

type Backend = {
  invoke(scope: "$" | "orders", name: string, input: unknown, id?: string): Promise<WireResponse>;
  list(collection: "orders" | "inventory" | "events"): Promise<string[]>;
  addOrder(id: string, value: string): Promise<void>;
  getOrder(id: string): Promise<string>;
};

async function exerciseAtomicActions(backend: Backend, prefix: string): Promise<void> {
  await expect(
    backend.invoke("$", "transact", { prefix: `${prefix}-success`, failure: "none" }),
  ).resolves.toMatchObject({ ok: true });
  expect(await backend.list("orders")).toContain(`${prefix}-success-order`);
  expect(await backend.list("inventory")).toContain(`${prefix}-success-inventory`);
  expect(await backend.list("events")).toContain(`${prefix}-success-event`);

  for (const failure of ["second", "third", "storage", "handler", "policy"] as const) {
    const failedPrefix = `${prefix}-${failure}`;
    await expect(
      backend.invoke("$", "transact", { prefix: failedPrefix, failure }),
    ).resolves.toMatchObject({ ok: false });
    expect(await backend.list("orders")).not.toContain(`${failedPrefix}-order`);
    expect(await backend.list("inventory")).not.toContain(`${failedPrefix}-inventory`);
    expect(await backend.list("events")).not.toContain(`${failedPrefix}-event`);
  }

  const outputPrefix = `${prefix}-output`;
  await expect(backend.invoke("$", "invalidOutput", outputPrefix)).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_ACTION_OUTPUT" },
  });
  expect(await backend.list("orders")).not.toContain(`${outputPrefix}-order`);

  const collectionId = `${prefix}-collection`;
  await backend.addOrder(collectionId, "before");
  await expect(
    backend.invoke("orders", "updateThenFail", { value: "after" }, collectionId),
  ).resolves.toMatchObject({ ok: false });
  expect(await backend.getOrder(collectionId)).toBe("before");

  const nonAtomicPrefix = `${prefix}-non-atomic`;
  await expect(backend.invoke("$", "nonAtomic", nonAtomicPrefix)).resolves.toMatchObject({
    ok: false,
  });
  expect(await backend.list("orders")).toContain(`${nonAtomicPrefix}-order`);

  const effectPrefix = `${prefix}-effect`;
  await expect(backend.invoke("$", "external", effectPrefix)).resolves.toMatchObject({
    ok: false,
  });
  expect(await backend.list("orders")).not.toContain(`${effectPrefix}-order`);
  expect(externalEffects).toContain(effectPrefix);
  expect(externalEffects.filter((effect) => effect === effectPrefix)).toHaveLength(1);
}

test("atomic actions use actual SQLite-backed Durable Object transactions", async () => {
  const stub = env.TAKIBI_STORAGE_TEST.getByName(tenantId) as DurableObjectStub<StorageTestObject>;
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const object = new handler.DurableObject(state, {});
    const durable: Backend = {
      async invoke(scope, name, input, id) {
        const request: WireRequest = {
          kind: "action",
          scope,
          name,
          ...(id === undefined ? {} : { id }),
          input,
          context: { tenantId },
        };
        const response = await object.fetch(
          new Request("https://takibi.internal", {
            method: "POST",
            body: JSON.stringify(request),
          }),
        );
        return response.json<WireResponse>();
      },
      async list(collection) {
        const page = await object.$collections[collection].list();
        return page.items.map(({ id }) => id);
      },
      async addOrder(id, value) {
        await object.$collections.orders.add({ value }, { id });
      },
      async getOrder(id) {
        return (await object.$collections.orders.get(id)).value;
      },
    };
    await exerciseAtomicActions(durable, "durable");

    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    concurrencyGate = { entered: enter, released };
    const failing = durable.invoke("$", "waitThenFail", "concurrent");
    await entered;
    let concurrentSettled = false;
    const concurrent = durable.addOrder("concurrent-preserved", "preserved").then(() => {
      concurrentSettled = true;
    });
    await Promise.resolve();
    expect(concurrentSettled).toBe(false);
    release();
    await expect(failing).resolves.toMatchObject({ ok: false });
    await concurrent;
    await expect(durable.getOrder("concurrent-rolled-back")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(durable.getOrder("concurrent-preserved")).resolves.toBe("preserved");
    concurrencyGate = undefined;

    await object.$collections.$transaction(async ($collections) => {
      await $collections.orders.add({ value: "transaction" }, { id: "direct-transaction-order" });
      await $collections.inventory.add(
        { value: "transaction" },
        { id: "direct-transaction-inventory" },
      );
    });
    await expect(object.$collections.orders.get("direct-transaction-order")).resolves.toMatchObject(
      {
        value: "transaction",
      },
    );
    await expect(
      object.$collections.inventory.get("direct-transaction-inventory"),
    ).resolves.toMatchObject({ value: "transaction" });

    await expect(
      object.$collections.$transaction(async ($collections) => {
        await $collections.orders.add({ value: "rolled back" }, { id: "direct-rollback-order" });
        await $collections.inventory.add(
          { value: "rolled back" },
          { id: "direct-rollback-inventory" },
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(object.$collections.orders.get("direct-rollback-order")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      object.$collections.inventory.get("direct-rollback-inventory"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
