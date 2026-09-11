import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "takibi";
import type { WireRequest, WireResponse } from "../src/protocol";
import type { StorageTestObject } from "./worker";

test("generated DO runs services factory per instance from env", async () => {
  type Env = { LABEL: string };
  const context = createTakibi<Record<string, never>, Env>()({
    resolve: () => ({ tenantId: "unused" }),
    services: ({ env: servicesEnv }) => ({ label: servicesEnv.LABEL }),
  });
  const app = context.defineCollections({
    items: { schema: z.object({ n: z.number() }), accessPolicy: fullAccess },
  });
  const handler = app.actions({
    $: {
      readLabel: app
        .defineAction()
        .policy(fullAccess)
        .handler(({ services }) => ({ label: services.label })),
    },
  });

  const invoke = async (
    object: InstanceType<typeof handler.DurableObject>,
    tenantId: string,
  ): Promise<WireResponse> => {
    const response = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify({
          kind: "action",
          scope: "$",
          name: "readLabel",
          context: { tenantId },
        } satisfies WireRequest),
      }),
    );
    return response.json<WireResponse>();
  };

  const stubA = env.TAKIBI_STORAGE_TEST.getByName(
    "services-a",
  ) as DurableObjectStub<StorageTestObject>;
  const stubB = env.TAKIBI_STORAGE_TEST.getByName(
    "services-b",
  ) as DurableObjectStub<StorageTestObject>;
  await stubA.ping();
  await stubB.ping();

  await runInDurableObject(stubA, async (_instance, state) => {
    const object = new handler.DurableObject(state, { LABEL: "alpha" });
    await expect(invoke(object, "services-a")).resolves.toEqual({
      ok: true,
      data: { label: "alpha" },
    });
  });
  await runInDurableObject(stubB, async (_instance, state) => {
    const object = new handler.DurableObject(state, { LABEL: "beta" });
    await expect(invoke(object, "services-b")).resolves.toEqual({
      ok: true,
      data: { label: "beta" },
    });
  });
});
