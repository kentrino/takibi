import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  context,
  diag,
  DiagLogLevel,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { createOtelTakibiTracer, TakibiInstrumentation } from "../src/index";

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
    this.#storage.disable();
    return this;
  }
}

test("integration enables Takibi spans and preserves OTel context semantics", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 60_000 })],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalContextManager());

  const instrumentation = new TakibiInstrumentation();
  instrumentation.enable();
  expectTypeOf(TakibiInstrumentation).toBeConstructibleWith();
  expectTypeOf(createOtelTakibiTracer).toBeFunction();

  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  }).collections(
    {
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    },
    { memory: true },
  );
  const response = await handler.request("https://takibi.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "observed" }),
  });
  expect(response.status).toBe(200);

  const tracer = createOtelTakibiTracer();
  expectTypeOf(tracer).not.toHaveProperty("forceFlush");
  const parent = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: TraceFlags.SAMPLED,
    traceState: "vendor=sampled",
    isRemote: true,
  };
  const span = tracer.startSpan(
    {
      name: "takibi.integration",
      kind: "client",
      attributes: {
        "takibi.collection.name": "posts",
        "takibi.operation.name": "integration",
      },
    },
    parent,
  );
  span.runWithActiveContext(() => {
    const nested = trace.getTracer("third-party").startSpan("nested");
    nested.end();
  });
  span.recordException({ name: "IntegrationError", message: "integration failed" });
  span.setStatus({ code: "error", message: "integration failed" });
  const headers = new Headers();
  tracer.inject(headers, span.context);
  expect(headers.get("traceparent")).toMatch(/^00-1{32}-[0-9a-f]{16}-01$/);
  expect(headers.get("tracestate")).toBe("vendor=sampled");
  expect(tracer.extract(headers)).toMatchObject({
    traceId: parent.traceId,
    traceFlags: TraceFlags.SAMPLED,
    traceState: parent.traceState,
    isRemote: true,
  });
  span.end();

  const unsampled = tracer.startSpan(
    { name: "takibi.unsampled", kind: "internal", attributes: {} },
    {
      ...parent,
      traceId: "33333333333333333333333333333333",
      spanId: "4444444444444444",
      traceFlags: TraceFlags.NONE,
      traceState: "vendor=unsampled",
    },
  );
  const unsampledHeaders = new Headers();
  tracer.inject(unsampledHeaders, unsampled.context);
  expect(unsampledHeaders.get("traceparent")).toMatch(/^00-3{32}-[0-9a-f]{16}-00$/);
  expect(unsampledHeaders.get("tracestate")).toBe("vendor=unsampled");
  unsampled.end();

  await provider.forceFlush();
  const finished = exporter.getFinishedSpans();
  expect(finished.map(({ name }) => name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.storage", "takibi.integration", "nested"]),
  );
  expect(finished.map(({ name }) => name)).not.toContain("takibi.unsampled");
  const integration = finished.find(({ name }) => name === "takibi.integration");
  const nested = finished.find(({ name }) => name === "nested");
  expect(nested?.spanContext().traceId).toBe(integration?.spanContext().traceId);
  expect(nested?.parentSpanContext?.spanId).toBe(integration?.spanContext().spanId);
  expect(integration).toMatchObject({
    kind: SpanKind.CLIENT,
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.operation.name": "integration",
    },
    status: {
      code: SpanStatusCode.ERROR,
      message: "integration failed",
    },
  });
  expect(integration?.events).toEqual([
    expect.objectContaining({
      name: "exception",
      attributes: expect.objectContaining({
        "exception.type": "IntegrationError",
        "exception.message": "integration failed",
      }),
    }),
  ]);

  instrumentation.disable();
  await provider.shutdown();
  context.disable();
});

test("enable warns once when context is not propagating", () => {
  const warnings: string[] = [];
  diag.setLogger(
    {
      verbose() {},
      debug() {},
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
    DiagLogLevel.ALL,
  );
  const instrumentation = new TakibiInstrumentation();
  context.setGlobalContextManager(new AsyncLocalContextManager());
  instrumentation.enable();
  expect(warnings).toEqual([]);
  instrumentation.disable();
  context.disable();

  instrumentation.enable();
  instrumentation.enable();
  expect(warnings).toEqual([expect.stringContaining("context is not propagating")]);
  instrumentation.disable();
  diag.disable();
});

test("package README documents setup and isolate-local flushing", () => {
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  const source = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  expect(readme).toContain('from "@takibi/takibi-opentelemetry"');
  expect(readme).toContain("TakibiInstrumentation");
  expect(readme).toContain("createOtelTakibiTracer");
  expect(readme).toContain("createTakibi");
  expect(readme).toContain("trace.setGlobalTracerProvider(provider)");
  expect(readme).toContain("context.setGlobalContextManager");
  expect(readme).toContain(
    "pnpm add @takibi/takibi @takibi/takibi-opentelemetry @opentelemetry/api",
  );
  expect(readme).toContain("waitUntil(provider.forceFlush())");
  expect(readme).toContain("only the provider owned by the calling");
  expect(source).not.toMatch(/forceFlush|getDelegate|TracerProvider/);
  expect(source).not.toMatch(/@opentelemetry\/sdk|SpanProcessor|SpanExporter/);
  expect(source).not.toMatch(/instanceof Error|new Error\(String/);
});
