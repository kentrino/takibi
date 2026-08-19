import { expect, expectTypeOf, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { z } from "zod";
import { createClient, createTakibi, fullAccess } from "../src/index";
import { TakibiInstrumentation, createOtelTakibiTracer } from "../src/otel";
import { registerGlobalTracer } from "../src/tracing";
import { createSqliteDurableObjectStorage } from "./sqlite";

const Post = z.object({ title: z.string().min(1) });

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

test("./otel registers a real provider without changing root inference", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

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

  await createOtelTakibiTracer().forceFlush();
  const exported = exporter.getFinishedSpans();
  expect(exported.map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.wire", "takibi.executor", "takibi.storage"]),
  );

  instrumentation.disable();
  await provider.shutdown();
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

test("README documents ./otel enable and waitUntil flush", () => {
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  expect(readme).toContain('from "@takibi/takibi/otel"');
  expect(readme).toContain("TakibiInstrumentation");
  expect(readme).toContain("createOtelTakibiTracer");
  expect(readme).toContain("instrumentation.enable()");
  expect(readme).toContain("waitUntil(createOtelTakibiTracer().forceFlush())");
  expect(readme).not.toContain("registerGlobalTracer");
  expect(readme).not.toContain("internalTracerKey");
  expect(readme).not.toContain("CollectionsOptions.tracer");
});
