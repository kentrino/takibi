import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "../src/index";
import { createRecordingTracer, internalTracerKey, registerGlobalTracer } from "../src/tracing";

test("Workers runtime records spans and flushes through waitUntil without Node auto-instrumentation", async () => {
  expect(import.meta.url.includes("opentelemetry")).toBe(false);
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  }).collections(
    { posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess } },
    { memory: true, [internalTracerKey]: recording.tracer },
  );
  const response = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "workers" }),
  });
  expect(response.status).toBe(200);
  expect(recording.spans.some((span) => span.name === "takibi.resolve")).toBe(true);
  expect(recording.spans.some((span) => span.name === "takibi.storage")).toBe(true);

  const executionContext = createExecutionContext();
  executionContext.waitUntil(recording.forceFlush());
  await waitOnExecutionContext(executionContext);
  expect(recording.didFlush).toBe(true);
  registerGlobalTracer(undefined);
});
