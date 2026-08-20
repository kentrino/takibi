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
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
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

test("real OTel provider exports spans after waitUntil flush", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalContextManager());
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
  context.disable();
  registerGlobalTracer(undefined);
});
