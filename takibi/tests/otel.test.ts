import { expect, expectTypeOf, test } from "vite-plus/test";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { z } from "zod";
import { createClient } from "@takibi/takibi/client";
import { createTakibi, fullAccess } from "../src/index";
import { TakibiInstrumentation, createOtelTakibiTracer } from "../src/otel";
import {
  bindTracer,
  extractSpanContext,
  injectTraceparent,
  registerGlobalTracer,
  withSpan,
} from "../src/tracing";
import { createSqliteDurableObjectStorage } from "./sqlite";

const Post = z.object({ title: z.string().min(1) });

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

function createFakeDurableObjectState(
  storage: DurableObjectStorage,
  id: { name?: string } = {},
): DurableObjectState {
  return {
    storage,
    id,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

test("./otel preserves sampling and tracestate without changing root inference", async () => {
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

  let captured: Request | undefined;
  const contextFactory = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: () =>
      ({
        fetch: (request: Request) => {
          captured = request.clone();
          return object.fetch(request);
        },
      }) as unknown as DurableObjectStub,
  });
  const off = contextFactory.collections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const on = contextFactory.collections({ posts: { schema: Post, accessPolicy: fullAccess } });
  expectTypeOf(on).toEqualTypeOf(off);
  expectTypeOf(createClient<typeof on>("http://fire.test")).toEqualTypeOf(
    createClient<typeof off>("http://fire.test"),
  );
  const object = new on.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );

  const response = await on.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "otel" }),
  });
  expect(response.status).toBe(200);
  expect(captured).toBeDefined();
  const carrier: Record<string, string> = {};
  captured!.headers.forEach((value, key) => {
    carrier[key] = value;
  });
  const extracted = propagation.extract(context.active(), carrier);
  const extractedSpan = trace.getSpanContext(extracted);
  expect(captured!.headers.get("traceparent")).toMatch(
    /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
  );
  expect(extractedSpan?.traceId).toBeDefined();
  expect(extractedSpan?.spanId).toBeDefined();

  expect(exporter.getFinishedSpans()).toEqual([]);
  await createOtelTakibiTracer().forceFlush();
  const exported = exporter.getFinishedSpans();
  expect(exported.map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.wire", "takibi.executor", "takibi.storage"]),
  );

  const tracer = createOtelTakibiTracer();
  await bindTracer(tracer, () =>
    withSpan("takibi.action", async () => {
      const nested = trace.getTracer("third-party").startSpan("nested");
      nested.end();
    }),
  );
  await tracer.forceFlush();
  const actionSpan = exporter.getFinishedSpans().find((span) => span.name === "takibi.action");
  const nestedSpan = exporter.getFinishedSpans().find((span) => span.name === "nested");
  expect(actionSpan).toBeDefined();
  expect(nestedSpan?.spanContext().traceId).toBe(actionSpan?.spanContext().traceId);
  expect(nestedSpan?.parentSpanContext?.spanId).toBe(actionSpan?.spanContext().spanId);

  const crossBoundary = async (parent: {
    traceId: string;
    spanId: string;
    traceFlags: number;
    traceState: string;
    isRemote: boolean;
  }): Promise<Headers> => {
    const headers = new Headers();
    await bindTracer(tracer, () =>
      withSpan(
        "takibi.worker",
        async () => {
          injectTraceparent(headers);
        },
        parent,
      ),
    );
    const extracted = bindTracer(tracer, () => extractSpanContext(headers));
    expect(extracted).toMatchObject({
      traceFlags: parent.traceFlags,
      traceState: parent.traceState,
      isRemote: true,
    });
    await bindTracer(tracer, () => withSpan("takibi.do", async () => {}, extracted));
    return headers;
  };

  const sampledHeaders = await crossBoundary({
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: TraceFlags.SAMPLED,
    traceState: "vendor=sampled",
    isRemote: true,
  });
  expect(sampledHeaders.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(sampledHeaders.get("tracestate")).toBe("vendor=sampled");
  expect(exporter.getFinishedSpans().map((span) => span.name)).not.toEqual(
    expect.arrayContaining(["takibi.worker", "takibi.do"]),
  );
  await tracer.forceFlush();
  expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.worker", "takibi.do"]),
  );

  exporter.reset();
  const unsampledHeaders = await crossBoundary({
    traceId: "33333333333333333333333333333333",
    spanId: "4444444444444444",
    traceFlags: TraceFlags.NONE,
    traceState: "vendor=unsampled",
    isRemote: true,
  });
  expect(unsampledHeaders.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  expect(unsampledHeaders.get("tracestate")).toBe("vendor=unsampled");
  await createOtelTakibiTracer().forceFlush();
  expect(exporter.getFinishedSpans()).toEqual([]);

  instrumentation.disable();
  await provider.shutdown();
  context.disable();
  registerGlobalTracer(undefined);
});

test("root source does not import OTel packages", () => {
  const root = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  const contextSource = readFileSync(join(import.meta.dirname, "../src/context.ts"), "utf8");
  const packConfig = readFileSync(join(import.meta.dirname, "../vite.config.ts"), "utf8");
  expect(root).not.toMatch(/opentelemetry|\/otel/);
  expect(contextSource).not.toMatch(/opentelemetry|from "\.\/otel"/);
  expect(packConfig).toContain('otel: "src/otel.ts"');
});

test("README documents ./otel enable and isolate-local flush semantics", () => {
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  expect(readme).toContain('from "@takibi/takibi/otel"');
  expect(readme).toContain("TakibiInstrumentation");
  expect(readme).toContain("createOtelTakibiTracer");
  expect(readme).toContain("instrumentation.enable()");
  expect(readme).toContain("waitUntil(createOtelTakibiTracer().forceFlush())");
  expect(readme).toContain("context manager");
  expect(readme).toContain("root `@takibi/takibi` import does not require `nodejs_als`");
  expect(readme).toContain("apply that context manager's runtime compatibility requirements");
  expect(readme).toContain("only the provider in the calling Worker isolate");
  expect(readme).toMatch(/does not guarantee export before a\s+Durable Object response completes/);
  expect(readme).toContain("BatchSpanProcessor");
  expect(readme).not.toContain("registerGlobalTracer");
  expect(readme).not.toContain("internalTracerKey");
  expect(readme).not.toContain("CollectionsOptions.tracer");
});
