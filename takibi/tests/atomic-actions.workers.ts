import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess, none } from "../src/index";
import type { WireRequest, WireResponse } from "../src/protocol";
import type { StorageTestObject } from "./worker";

const tenantId = "atomic-actions";
const externalEffects: string[] = [];
const context = createTakibi()({ resolve: () => ({ tenantId }) });
const RecordSchema = z.object({ value: z.string().min(1) });
const orders = context.defineCollection({
  schema: RecordSchema,
  accessPolicy: fullAccess,
  actions: (defineAction) => ({
    updateThenFail: defineAction()
      .input(z.object({ id: z.string(), value: z.string() }))
      .atomic()
      .policy(fullAccess)
      .handler(async ({ input, $collection }) => {
        await $collection.update(input.id, { value: input.value });
        throw new Error("collection action failed");
      }),
  }),
});
const base = context.collections(
  {
    orders,
    inventory: { schema: RecordSchema, accessPolicy: fullAccess },
    events: { schema: RecordSchema, accessPolicy: fullAccess },
    blocked: { schema: RecordSchema, accessPolicy: none },
  },
  { memory: true },
);
const Input = z.object({
  prefix: z.string(),
  failure: z.enum(["none", "second", "third", "storage", "handler", "policy"]),
});
const transact = base
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
const invalidOutput = base
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
const nonAtomic = base
  .defineAction()
  .input(z.string())
  .policy(fullAccess)
  .handler(async ({ input, $collections }) => {
    await $collections.orders.add({ value: "non-atomic" }, { id: `${input}-order` });
    throw new Error("non-atomic failed");
  });
const external = base
  .defineAction()
  .input(z.string())
  .atomic()
  .policy(fullAccess)
  .handler(async ({ input, $collections }) => {
    await $collections.orders.add({ value: "external" }, { id: `${input}-order` });
    externalEffects.push(input);
    throw new Error("external failed");
  });
const handler = base.actions({ transact, invalidOutput, nonAtomic, external });

type Backend = {
  invoke(scope: "$" | "orders", name: string, input: unknown): Promise<WireResponse>;
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
    backend.invoke("orders", "updateThenFail", { id: collectionId, value: "after" }),
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

test("atomic actions have matching memory and actual SQLite-backed DO semantics", async () => {
  const memory: Backend = {
    async invoke(scope, name, input) {
      const response = await handler.request(`http://takibi.test/${scope}:${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return response.json<WireResponse>();
    },
    async list(collection) {
      const response = await handler.request(`http://takibi.test/${collection}`);
      const wire = await response.json<WireResponse>();
      if (!wire.ok) throw new Error(wire.error.message);
      return (wire.data as { items: Array<{ id: string }> }).items.map(({ id }) => id);
    },
    async addOrder(id, value) {
      const response = await handler.request(`http://takibi.test/orders/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      expect(response.status).toBe(200);
    },
    async getOrder(id) {
      const response = await handler.request(`http://takibi.test/orders/${id}`);
      const wire = await response.json<WireResponse>();
      if (!wire.ok) throw new Error(wire.error.message);
      return (wire.data as { value: string }).value;
    },
  };
  await exerciseAtomicActions(memory, "memory");

  const stub = env.TAKIBI_STORAGE_TEST.getByName(tenantId) as DurableObjectStub<StorageTestObject>;
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const object = new handler.DurableObject(state, {});
    const durable: Backend = {
      async invoke(scope, name, input) {
        const request: WireRequest = {
          kind: "action",
          scope,
          name,
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
  });
});
