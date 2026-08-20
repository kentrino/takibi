import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test } from "vite-plus/test";
import { propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { createTakibi, fullAccess } from "../src/index";
import { createOtelTakibiTracer, TakibiInstrumentation } from "../src/otel";
import { createRecordingTracer, registerGlobalTracer } from "../src/tracing";

test("global-only Workers runtime records spans and flushes through waitUntil", async () => {
  expect(import.meta.url.includes("opentelemetry")).toBe(false);
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  }).collections(
    { posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess } },
    { memory: true },
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

test("real OTel provider exports spans after waitUntil flush", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const instrumentation = new TakibiInstrumentation();
  instrumentation.enable();

  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  }).collections(
    { posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess } },
    { memory: true },
  );
  const response = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "workers-otel" }),
  });
  expect(response.status).toBe(200);

  const executionContext = createExecutionContext();
  executionContext.waitUntil(createOtelTakibiTracer().forceFlush());
  await waitOnExecutionContext(executionContext);
  expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.executor", "takibi.storage"]),
  );

  instrumentation.disable();
  await provider.shutdown();
  registerGlobalTracer(undefined);
});
