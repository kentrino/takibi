import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "@takibi/policy";
import { createTakibi } from "../src";
import type { WireRequest, WireResponse } from "../src";
import type { StorageTestObject } from "./worker";

test("Durable Object wire path runs CRUD, action, and batch through fetch", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  });
  const app = context.defineCollections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
    },
  });
  const ping = app
    .defineAction()
    .policy(fullAccess)
    .handler(() => ({ pong: true }));
  const handler = app.actions({ $: { ping } });

  const stub = env.TAKIBI_STORAGE_TEST.getByName(
    "tenant-runtime",
  ) as DurableObjectStub<StorageTestObject>;
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const object = new handler.DurableObject(state, {});
    const add: WireRequest = {
      kind: "collection",
      collection: "posts",
      operation: "add",
      id: "p1",
      input: { title: "from-do" },
      context: { tenantId: "tenant-runtime" },
    };
    const addResponse = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify(add),
      }),
    );
    expect(addResponse.status).toBe(200);
    await expect(addResponse.json<WireResponse>()).resolves.toMatchObject({
      ok: true,
      data: { id: "p1", title: "from-do" },
    });

    const get: WireRequest = {
      kind: "collection",
      collection: "posts",
      operation: "get",
      id: "p1",
      context: { tenantId: "tenant-runtime" },
    };
    const getResponse = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify(get),
      }),
    );
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json<WireResponse>()).resolves.toMatchObject({
      ok: true,
      data: { id: "p1", title: "from-do" },
    });

    const actionResponse = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify({
          kind: "action",
          scope: "$",
          name: "ping",
          context: { tenantId: "tenant-runtime" },
        } satisfies WireRequest),
      }),
    );
    expect(actionResponse.status).toBe(200);
    await expect(actionResponse.json<WireResponse>()).resolves.toEqual({
      ok: true,
      data: { pong: true },
    });

    const batchResponse = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify({
          kind: "batch",
          items: [
            { kind: "collection", collection: "posts", operation: "get", id: "missing" },
            { kind: "collection", collection: "posts", operation: "get", id: "p1" },
          ],
          context: { tenantId: "tenant-runtime" },
        } satisfies WireRequest),
      }),
    );
    expect(batchResponse.status).toBe(200);
    await expect(batchResponse.json<WireResponse>()).resolves.toEqual({
      ok: true,
      data: [
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "NOT_FOUND" }),
        }),
        expect.objectContaining({ ok: true, data: expect.objectContaining({ id: "p1" }) }),
      ],
    });
  });
});
