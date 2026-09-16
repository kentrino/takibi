import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { fullAccess } from "@takibi/policy";
import { createTakibi } from "@takibi/worker-runtime";
import type { WireRequest, WireResponse } from "@takibi/worker-runtime";
import type { StorageTestObject } from "./worker";

test("Durable Object wire path runs CRUD, action, and batch through fetch", async () => {
  const context = createTakibi()({
    resolve: () => ({ accountId: "account-a" }),
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
    .handler(({ ctx }) => ({ accountId: ctx.accountId }));
  const handler = app.actions({ $: { ping } });

  const stub = env.TAKIBI_STORAGE_TEST.getByName(
    "account:account-a",
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
      context: { accountId: "account-a" },
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
      context: { accountId: "account-a" },
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
          context: { accountId: "account-a" },
        } satisfies WireRequest),
      }),
    );
    expect(actionResponse.status).toBe(200);
    await expect(actionResponse.json<WireResponse>()).resolves.toEqual({
      ok: true,
      data: { accountId: "account-a" },
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
          context: { accountId: "account-a" },
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
