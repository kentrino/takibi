import { afterEach, expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, createTakibi, fullAccess, none } from "../src/index";
import {
  createRecordingTracer,
  failNextStorageWrite,
  formatTraceparent,
  internalTracerKey,
  registerGlobalTracer,
  type RecordedSpan,
} from "../src/tracing";
import { createSqliteDurableObjectStorage } from "./sqlite";
import type { WireResponse } from "../src/protocol";

/**
 * Discovery 0043 results (re-reconcile concern 0021 with pre-1.0-capability-development):
 * - B (global register) and C (internal tracer option) both produce the same parent/child spans.
 * - A (no adapter) produces no internal spans.
 * - Discard conditions: none matched. Failures are identified without application `traceId`,
 *   without lifecycle hooks, and with tracing disabled requiring no OTel package.
 */
const Post = z.object({ title: z.string().min(1) });

afterEach(() => {
  registerGlobalTracer(undefined);
});

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

function child(spans: RecordedSpan[], parent: RecordedSpan, name: string): RecordedSpan {
  const found = spans.find((span) => span.name === name && span.parentSpanId === parent.spanId);
  expect(found, `missing child ${name} of ${parent.name}`).toBeDefined();
  return found!;
}

function spanNamed(spans: RecordedSpan[], name: string): RecordedSpan {
  const found = spans.find((span) => span.name === name);
  expect(found, `missing span ${name}`).toBeDefined();
  return found!;
}

test("A baseline records no internal spans", async () => {
  const recording = createRecordingTracer();
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  }).collections({ posts: { schema: Post, accessPolicy: fullAccess } }, { memory: true });
  const added = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  expect(added.status).toBe(200);
  expect(recording.spans).toEqual([]);
});

test("C explicit internal tracer records Worker-DO-executor-storage parentage", async () => {
  const recording = createRecordingTracer();
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: () =>
      ({
        fetch: (request: Request) => object.fetch(request),
      }) as unknown as DurableObjectStub,
  });
  const options = { [internalTracerKey]: recording.tracer };
  const handler = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    options,
  );
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );
  const added = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  expect(added.status).toBe(200);

  const resolve = spanNamed(recording.spans, "takibi.resolve");
  const wire = child(recording.spans, resolve, "takibi.wire");
  const executor = child(recording.spans, wire, "takibi.executor");
  expect(spanNamed(recording.spans, "takibi.storage").parentSpanId).toBe(executor.spanId);
  expect(new Set(recording.spans.map((span) => span.traceId)).size).toBe(1);
  expect(recording.spans.every((span) => span.ended)).toBe(true);
});

test("B global registration matches C span names without collections options", async () => {
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  }).collections({ posts: { schema: Post, accessPolicy: fullAccess } }, { memory: true });
  await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  expect(recording.spans.map((span) => span.name)).toEqual(
    expect.arrayContaining(["takibi.resolve", "takibi.executor", "takibi.storage"]),
  );
});

test("injected failures record error on the failed interval and still end", async () => {
  const cases = [
    {
      name: "takibi.resolve",
      context: () =>
        createTakibi()({
          resolve: () => {
            throw new Error("resolve-failed");
          },
        }),
      path: "http://fire.test/posts",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "n" }),
      },
    },
    {
      name: "takibi.wire",
      context: () =>
        createTakibi()({
          resolve: () => ({ tenantId: "t" }),
          stub: () =>
            ({
              fetch: async () => {
                throw new Error("stub-failed");
              },
            }) as unknown as DurableObjectStub,
        }),
      path: "http://fire.test/posts",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "n" }),
      },
    },
    {
      name: "takibi.policy",
      context: () => createTakibi()({ resolve: () => ({ tenantId: "t" }) }),
      collections: { posts: { schema: Post, accessPolicy: none } },
      path: "http://fire.test/posts",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "n" }),
      },
    },
    {
      name: "takibi.schema",
      context: () => createTakibi()({ resolve: () => ({ tenantId: "t" }) }),
      path: "http://fire.test/posts",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "" }),
      },
    },
    {
      name: "takibi.storage",
      context: () => createTakibi()({ resolve: () => ({ tenantId: "t" }) }),
      failStorage: true,
      path: "http://fire.test/posts",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "n" }),
      },
    },
    {
      name: "takibi.action",
      context: () => createTakibi()({ resolve: () => ({ tenantId: "t" }) }),
      action: true,
      path: "http://fire.test/$:boom",
      init: { method: "POST" as const },
    },
  ];

  for (const testCase of cases) {
    const recording = createRecordingTracer();
    const builder = testCase.context();
    const base = builder.collections(
      testCase.collections ?? { posts: { schema: Post, accessPolicy: fullAccess } },
      {
        ...(testCase.name === "takibi.wire" ? {} : { memory: true }),
        [internalTracerKey]: recording.tracer,
      },
    );
    const handler = testCase.action
      ? base.actions({
          boom: base
            .defineAction()
            .policy(fullAccess)
            .handler(() => {
              throw new Error("action-failed");
            }),
        })
      : base;
    if (testCase.failStorage) failNextStorageWrite();
    const response = await handler.request(testCase.path, testCase.init);
    const body = (await response.json()) as WireResponse;
    expect(body.ok, testCase.name).toBe(false);
    const failed =
      recording.spans.find((span) => span.name === testCase.name && span.status === "error") ??
      spanNamed(recording.spans, testCase.name);
    expect(failed.status, testCase.name).toBe("error");
    expect(failed.ended, testCase.name).toBe(true);
    expect(
      recording.spans.every((span) => span.ended),
      `${testCase.name} left an open span`,
    ).toBe(true);
  }
});

test("wire error conversion still identifies the failed interval", async () => {
  const recording = createRecordingTracer();
  const handler = createTakibi()({ resolve: () => ({ tenantId: "t" }) }).collections(
    { posts: { schema: Post, accessPolicy: none } },
    { memory: true, [internalTracerKey]: recording.tracer },
  );
  const response = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  const body = (await response.json()) as WireResponse;
  expect(body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(spanNamed(recording.spans, "takibi.policy")).toMatchObject({
    status: "error",
    ended: true,
  });
});

test("W3C traceparent is injected on the internal Request and not via context.traceId", async () => {
  const recording = createRecordingTracer();
  let captured: Request | undefined;
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: () =>
      ({
        fetch: (request: Request) => {
          captured = request.clone();
          return object.fetch(request);
        },
      }) as unknown as DurableObjectStub,
  });
  const handler = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { [internalTracerKey]: recording.tracer },
  );
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );
  await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  expect(captured).toBeDefined();
  const traceparent = captured!.headers.get("traceparent");
  const wire = spanNamed(recording.spans, "takibi.wire");
  expect(traceparent).toBe(formatTraceparent(wire));
  const body = (await captured!.clone().json()) as { context: Record<string, unknown> };
  expect(body.context).not.toHaveProperty("traceId");
});

test("tracing presence does not change collections, handler, or client inference", () => {
  const recording = createRecordingTracer();
  const context = createTakibi()({ resolve: () => ({ tenantId: "t" }) });
  const off = context.collections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const options = { [internalTracerKey]: recording.tracer };
  const on = context.collections({ posts: { schema: Post, accessPolicy: fullAccess } }, options);
  expectTypeOf(on).toEqualTypeOf(off);
  expectTypeOf(createClient<typeof on>("http://fire.test")).toEqualTypeOf(
    createClient<typeof off>("http://fire.test"),
  );
});

test("OTel and tracing helpers stay off the public root", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(JSON.stringify(pkg.dependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(JSON.stringify(pkg.devDependencies ?? {})).not.toMatch(/opentelemetry/);

  type PublicModule = typeof import("../src/index");
  type Hidden =
    | "internalTracerKey"
    | "registerGlobalTracer"
    | "createRecordingTracer"
    | "TakibiTracer"
    | "TakibiSpan";
  expectTypeOf<Extract<Hidden, keyof PublicModule>>().toBeNever();
  expectTypeOf(import("../src/index")).not.toHaveProperty("internalTracerKey");
});
