import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vite-plus/test";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  BasicTracerProvider,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { createTakibi, fullAccess } from "../src/index";
import { createOtelTakibiTracer, TakibiInstrumentation } from "../src/otel";
import { createRecordingTracer, registerGlobalTracer } from "../src/tracing";

class AsyncLocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(activeContext, () => fn.call(thisArg, ...args));
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

type ExportedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

test("global-only Workers runtime records spans and flushes through waitUntil", async () => {
  expect(import.meta.url.includes("opentelemetry")).toBe(false);
  context.setGlobalContextManager(new AsyncLocalContextManager());
  const instrumentation = new TakibiInstrumentation();
  instrumentation.enable();
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
  instrumentation.disable();
  context.disable();
});

test("real OTel provider propagates spans through an actual Durable Object namespace", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 60_000 })],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalContextManager());
  const instrumentation = new TakibiInstrumentation();
  instrumentation.enable();

  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
    stub: ({ resolved }) => env.TAKIBI_TRACING_TEST.getByName(resolved.tenantId),
  }).collections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const response = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "workers-otel" }),
  });
  expect(response.status).toBe(200);
  expect(exporter.getFinishedSpans()).toEqual([]);

  const executionContext = createExecutionContext();
  executionContext.waitUntil(createOtelTakibiTracer().forceFlush());
  await waitOnExecutionContext(executionContext);
  const workerSpans = exporter.getFinishedSpans();
  expect(workerSpans.map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.wire"]),
  );

  const object = env.TAKIBI_TRACING_TEST.getByName("t");
  const objectSpans = await (
    await object.fetch(new Request("https://takibi.test/__test/exported-spans"))
  ).json<ExportedSpan[]>();
  expect(objectSpans.map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.executor", "takibi.storage"]),
  );

  const wire = workerSpans.find((span) => span.name === "takibi.wire");
  const executor = objectSpans.find((span) => span.name === "takibi.executor");
  const storage = objectSpans.find((span) => span.name === "takibi.storage");
  expect(executor?.traceId).toBe(wire?.spanContext().traceId);
  expect(executor?.parentSpanId).toBe(wire?.spanContext().spanId);
  expect(storage?.traceId).toBe(executor?.traceId);
  expect(storage?.parentSpanId).toBe(executor?.spanId);

  instrumentation.disable();
  await provider.shutdown();
  context.disable();
  registerGlobalTracer(undefined);
});
