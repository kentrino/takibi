import { env } from "cloudflare:workers";
import { SpanKind } from "@opentelemetry/api";
import { expect, test } from "vite-plus/test";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { z } from "zod";
import { flushOwnedProviderAndReadSpans, type FlushedSpans } from "./worker";

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

  const workerFlush = await flushOwnedProviderAndReadSpans("worker");
  expect(workerFlush.owner).toBe("worker");
  expect(workerFlush.flushCount).toBe(1);
  const workerSpans = workerFlush.spans;
  expect(workerSpans.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.wire"]),
  );

  const object = env.TAKIBI_TRACING_TEST.getByName("tenant-a");
  const objectFlush = await (
    await object.fetch(new Request("https://takibi.test/__test/exported-spans"))
  ).json<FlushedSpans>();
  expect(objectFlush.owner).toBe("durable-object");
  expect(objectFlush.flushCount).toBeGreaterThanOrEqual(1);
  const objectSpans = objectFlush.spans;
  expect(objectSpans.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["takibi.executor", "takibi.storage"]),
  );

  const wire = workerSpans.find(({ name }) => name === "takibi.wire");
  const executor = objectSpans.find(({ name }) => name === "takibi.executor");
  const storage = objectSpans.find(
    ({ name, attributes }) =>
      name === "takibi.storage" && attributes["takibi.storage.operation"] === "put",
  );
  expect(wire).toMatchObject({
    kind: SpanKind.CLIENT,
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.operation.name": "add",
    },
  });
  expect(executor).toMatchObject({
    kind: SpanKind.SERVER,
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.operation.name": "add",
    },
  });
  expect(storage).toMatchObject({
    kind: SpanKind.INTERNAL,
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.storage.operation": "put",
      "takibi.document.id": expect.any(String),
    },
  });
  expect(executor?.traceId).toBe(wire?.traceId);
  expect(executor?.parentSpanId).toBe(wire?.spanId);
  expect(storage?.traceId).toBe(executor?.traceId);
  expect(storage?.parentSpanId).toBe(executor?.spanId);
});
