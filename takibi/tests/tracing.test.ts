import { afterEach, expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@takibi/takibi/client";
import { createTakibi, fullAccess, none } from "../src/index";
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
 * Discovery 0043/0044 results (re-reconcile concern 0021 with pre-1.0-capability-development):
 * - B (global-only) maintains Worker → DO → executor → storage parentage and shared traceId.
 * - C (internal tracer option) still matches B. A (no adapter) produces no internal spans.
 * - `takibi.resolve` is limited to resolve(); wire/executor start after it ends.
 * - `@takibi/takibi/otel` adapts a real provider; root import stays OTel-free.
 * - Discard conditions: none matched. No public CollectionsOptions.tracer or lifecycle hook.
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

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

test("B global-only records Worker-DO-executor-storage parentage", async () => {
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: () =>
      ({
        fetch: (request: Request) => object.fetch(request),
      }) as unknown as DurableObjectStub,
  });
  const handler = context.collections({ posts: { schema: Post, accessPolicy: fullAccess } });
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
  expect(recording.spans.every((span) => span.ended && span.endCount === 1)).toBe(true);
});

test("takibi.resolve ends before wire and executor start", async () => {
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  const holdResolve = createDeferred();
  const enteredResolve = createDeferred();
  const enteredWire = createDeferred();
  let resolveEndedBeforeWire = false;
  const handler = createTakibi()({
    resolve: async () => {
      enteredResolve.resolve();
      await holdResolve.promise;
      return { tenantId: "tenant-a" };
    },
    stub: () =>
      ({
        fetch: (request: Request) => {
          resolveEndedBeforeWire = spanNamed(recording.spans, "takibi.resolve").ended;
          enteredWire.resolve();
          return object.fetch(request);
        },
      }) as unknown as DurableObjectStub,
  }).collections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );

  const responsePromise = handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  await enteredResolve.promise;
  expect(recording.spans.map((span) => span.name)).toEqual(["takibi.resolve"]);
  expect(spanNamed(recording.spans, "takibi.resolve").ended).toBe(false);
  holdResolve.resolve();
  await enteredWire.promise;
  expect(resolveEndedBeforeWire).toBe(true);
  expect(spanNamed(recording.spans, "takibi.resolve").ended).toBe(true);
  expect((await responsePromise).status).toBe(200);
  const resolve = spanNamed(recording.spans, "takibi.resolve");
  const wire = child(recording.spans, resolve, "takibi.wire");
  expect(child(recording.spans, wire, "takibi.executor").ended).toBe(true);
});

test("DO path injected failures mark the innermost span and end every span once", async () => {
  const cases = [
    {
      name: "takibi.policy",
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
      path: "http://fire.test/posts",
      init: {
        method: "POST" as const,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "" }),
      },
    },
    {
      name: "takibi.storage",
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
      action: true,
      path: "http://fire.test/$:boom",
      init: { method: "POST" as const },
    },
  ];

  for (const testCase of cases) {
    const recording = createRecordingTracer();
    registerGlobalTracer(recording.tracer);
    const builder = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      stub: () =>
        ({
          fetch: (request: Request) => object.fetch(request),
        }) as unknown as DurableObjectStub,
    });
    const base = builder.collections(
      testCase.collections ?? { posts: { schema: Post, accessPolicy: fullAccess } },
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
    const object = new handler.DurableObject(
      createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
      {},
    );
    if (testCase.failStorage) failNextStorageWrite();
    const response = await handler.request(testCase.path, testCase.init);
    const body = (await response.json()) as WireResponse;
    expect(body.ok, testCase.name).toBe(false);
    const failed =
      recording.spans.find((span) => span.name === testCase.name && span.status === "error") ??
      recording.spans.find((span) => span.name === testCase.name);
    expect(failed, testCase.name).toMatchObject({ status: "error", ended: true, endCount: 1 });
    expect(
      recording.spans.every((span) => span.ended && span.endCount === 1),
      `${testCase.name} left an open or double-ended span`,
    ).toBe(true);
  }
});

test("injected failures record error on the failed interval and still end", async () => {
  const cases = [
    {
      name: "takibi.resolve",
      context: () =>
        createTakibi()({
          resolve: (): { tenantId: string } => {
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

test("wire span covers response consumption and validates the transport envelope", async () => {
  const cases = [
    {
      name: "malformed JSON",
      response: () => new Response("{", { headers: { "content-type": "application/json" } }),
    },
    {
      name: "rejected body",
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body-failed"));
            },
          }),
        ),
    },
    {
      name: "malformed envelope",
      response: () => Response.json({ unexpected: true }),
    },
  ];

  for (const testCase of cases) {
    const recording = createRecordingTracer();
    const handler = createTakibi()({
      resolve: () => ({ tenantId: "t" }),
      stub: () =>
        ({
          fetch: async () => testCase.response(),
        }) as unknown as DurableObjectStub,
    }).collections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    );

    const response = await handler.request("http://fire.test/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "n" }),
    });
    expect(response.status, testCase.name).toBe(500);
    expect(spanNamed(recording.spans, "takibi.wire"), testCase.name).toMatchObject({
      status: "error",
      ended: true,
      endCount: 1,
    });
  }
});

test("wire span stays open through a delayed body", async () => {
  const recording = createRecordingTracer();
  const releaseBody = createDeferred();
  const bodyStarted = createDeferred();
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
    stub: () =>
      ({
        fetch: async () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                bodyStarted.resolve();
                await releaseBody.promise;
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ ok: true, data: { id: "p1" } })),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      }) as unknown as DurableObjectStub,
  }).collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { [internalTracerKey]: recording.tracer },
  );

  const responsePromise = handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  await bodyStarted.promise;
  expect(spanNamed(recording.spans, "takibi.wire").ended).toBe(false);
  releaseBody.resolve();
  expect((await responsePromise).status).toBe(200);
  expect(spanNamed(recording.spans, "takibi.wire")).toMatchObject({
    status: "ok",
    ended: true,
    endCount: 1,
  });
});

test("wire span treats a valid non-2xx failure envelope as a received remote result", async () => {
  const recording = createRecordingTracer();
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
    stub: () =>
      ({
        fetch: async () =>
          Response.json(
            {
              ok: false,
              error: {
                kind: "operation",
                code: "FORBIDDEN",
                message: "Forbidden",
                status: 403,
              },
            } satisfies WireResponse,
            { status: 403 },
          ),
      }) as unknown as DurableObjectStub,
  }).collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { [internalTracerKey]: recording.tracer },
  );

  const response = await handler.request("http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(spanNamed(recording.spans, "takibi.wire")).toMatchObject({
    status: "ok",
    ended: true,
    endCount: 1,
  });
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
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    exports?: Record<string, string>;
  };
  expect(JSON.stringify(pkg.dependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(pkg.peerDependencies?.["@opentelemetry/api"]).toBeDefined();
  expect(pkg.peerDependenciesMeta?.["@opentelemetry/api"]?.optional).toBe(true);
  expect(pkg.exports?.["./otel"]).toBe("./src/otel.ts");

  type PublicModule = typeof import("../src/index");
  type Hidden =
    | "internalTracerKey"
    | "registerGlobalTracer"
    | "createRecordingTracer"
    | "TakibiTracer"
    | "TakibiSpan"
    | "TakibiInstrumentation";
  expectTypeOf<Extract<Hidden, keyof PublicModule>>().toBeNever();
  expectTypeOf(import("../src/index")).not.toHaveProperty("internalTracerKey");
});
