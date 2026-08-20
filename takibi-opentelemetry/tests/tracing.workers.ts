import { env } from "cloudflare:workers";
import { expect, test } from "vite-plus/test";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { z } from "zod";
import { flushAndReadSpans, type ExportedSpan } from "./worker";

test("integration propagates OTel spans through a real Durable Object namespace", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: ({ resolved }) => env.TAKIBI_TRACING_TEST.getByName(resolved.tenantId),
  }).collections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
    },
  });

  const response = await handler.request("https://takibi.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "workers-otel" }),
  });
  expect(response.status).toBe(200);

  const workerSpans = await flushAndReadSpans();
  expect(workerSpans.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.wire"]),
  );

  const object = env.TAKIBI_TRACING_TEST.getByName("tenant-a");
  const objectSpans = await (
    await object.fetch(new Request("https://takibi.test/__test/exported-spans"))
  ).json<ExportedSpan[]>();
  expect(objectSpans.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["takibi.executor", "takibi.storage"]),
  );

  const wire = workerSpans.find(({ name }) => name === "takibi.wire");
  const executor = objectSpans.find(({ name }) => name === "takibi.executor");
  const storage = objectSpans.find(({ name }) => name === "takibi.storage");
  expect(executor?.traceId).toBe(wire?.traceId);
  expect(executor?.parentSpanId).toBe(wire?.spanId);
  expect(storage?.traceId).toBe(executor?.traceId);
  expect(storage?.parentSpanId).toBe(executor?.spanId);
});
