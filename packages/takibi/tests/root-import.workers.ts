import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "takibi";
import type { WireRequest, WireResponse } from "../src/protocol";
import type { StorageTestObject } from "./worker";

test("root import starts without Node compatibility on an older date", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});

  const stub = env.TAKIBI_STORAGE_TEST.getByName(
    "tenant-a",
  ) as DurableObjectStub<StorageTestObject>;
  await stub.ping();
  await runInDurableObject(stub, async (_instance, state) => {
    const object = new handler.DurableObject(state, {});
    const request: WireRequest = {
      kind: "collection",
      collection: "posts",
      operation: "add",
      input: { title: "compatible" },
      context: { tenantId: "tenant-a" },
    };
    const response = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json<WireResponse>()).resolves.toMatchObject({ ok: true });
  });
});
