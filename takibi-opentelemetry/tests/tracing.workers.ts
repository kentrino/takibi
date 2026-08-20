import { env } from "cloudflare:workers";
import { SpanKind } from "@opentelemetry/api";
import { expect, test } from "vite-plus/test";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { z } from "zod";
import { flushProviderAndReadSpans } from "./worker";

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

  // This pool loads the test and its Durable Object from one worker module graph, so it verifies
  // cross-namespace propagation and parentage, not production isolate-local provider ownership.
  const spans = await flushProviderAndReadSpans();
  expect(spans.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.wire", "takibi.executor", "takibi.storage"]),
  );

  const wire = spans.find(({ name }) => name === "takibi.wire");
  const executor = spans.find(({ name }) => name === "takibi.executor");
  const storage = spans.find(
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
