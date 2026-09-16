import { requestTakibi } from "./helpers/request";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import { createTakibi, fullAccess, none } from "takibi";
import {
  bindTracer,
  formatTraceparent,
  internalTracerKey,
  registerGlobalTracer,
  registerTracingContextBackend,
  withSpan,
  type TracingContextBackend,
} from "../src/tracing";
import { createFailingDocumentWriteStorage } from "./helpers/failing-storage";
import { createRecordingTracer, type RecordedSpan } from "./helpers/recording-tracer";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import type { WireResponse } from "../src/protocol";

/**
 * Tracing is injected through an internal option or process-local registration. Both paths preserve
 * Worker → Durable Object → executor → storage parentage and a shared trace ID, while no adapter
 * produces no internal spans. `takibi.resolve` covers only context resolution; wire and executor
 * spans begin after it ends. Real providers are adapted by the separate integration package so the
 * public root remains telemetry-provider agnostic.
 */
const Post = z.object({ title: z.string().min(1) });
const tracingStore = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();

beforeEach(() => {
  registerTracingContextBackend({
    getStore: () => tracingStore.getStore(),
    run: (store, fn) => tracingStore.run(store, fn),
  });
});

afterEach(() => {
  registerGlobalTracer(undefined);
  registerTracingContextBackend(undefined);
  tracingStore.disable();
});

function createFakeDurableObjectState(
  storage: DurableObjectStorage,
  id: { name?: string } = {},
): DurableObjectState {
  return {
    storage,
    id,
    getWebSockets: () => [],
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
  expectTypeOf(recording.tracer).not.toHaveProperty("forceFlush");
  expectTypeOf(recording).not.toHaveProperty("forceFlush");
  expect(recording.tracer).not.toHaveProperty("forceFlush");
  expect(recording).not.toHaveProperty("forceFlush");
  const production = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const added = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  expect(added.status).toBe(200);
  expect(recording.spans).toEqual([]);
});

test("public request span encloses the SQLite lifecycle and inherits an active parent", async () => {
  const recording = createRecordingTracer();
  const production = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    )
    .actions({});
  const handler = withSqliteTestBackend(production);

  const response = await bindTracer(recording.tracer, () =>
    withSpan({ name: "caller", kind: "server" }, async () =>
      requestTakibi(handler, "http://fire.test/posts", {
        method: "POST",
        headers: {
          authorization: "Bearer private-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "private document body" }),
      }),
    ),
  );

  expect(response.status).toBe(200);
  const caller = spanNamed(recording.spans, "caller");
  const requests = recording.spans.filter(({ name }) => name === "takibi.request");
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request).toMatchObject({
    kind: "server",
    attributes: {},
    parentSpanId: caller.spanId,
    ended: true,
    endCount: 1,
  });
  const resolve = child(recording.spans, request, "takibi.resolve");
  const executor = child(recording.spans, resolve, "takibi.executor");
  expect(child(recording.spans, executor, "takibi.storage").traceId).toBe(request.traceId);
  expect(JSON.stringify(request.attributes)).not.toMatch(
    /private-token|private document body|tenant-a|content-type/,
  );
});

test("decode failure creates and ends one root request span", async () => {
  const recording = createRecordingTracer();
  const production = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    )
    .actions({});
  const handler = withSqliteTestBackend(production);

  const response = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });

  expect(response.status).toBe(400);
  const requests = recording.spans.filter(({ name }) => name === "takibi.request");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    kind: "server",
    attributes: {},
    ended: true,
    endCount: 1,
  });
  expect(requests[0]).not.toHaveProperty("parentSpanId");
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
  const handler = context
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } }, options)
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );
  const added = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  expect(added.status).toBe(200);

  const request = spanNamed(recording.spans, "takibi.request");
  const resolve = child(recording.spans, request, "takibi.resolve");
  const wire = child(recording.spans, resolve, "takibi.wire");
  const executor = child(recording.spans, wire, "takibi.executor");
  const storage = recording.spans.find(
    (span) =>
      span.name === "takibi.storage" && span.attributes["takibi.storage.operation"] === "put",
  );
  const transaction = recording.spans.find(
    (span) =>
      span.name === "takibi.storage" &&
      span.attributes["takibi.storage.operation"] === "transaction",
  );
  expect(storage).toBeDefined();
  expect(transaction).toBeDefined();
  expect(transaction!.parentSpanId).toBe(executor.spanId);
  expect(storage!.parentSpanId).toBe(transaction!.spanId);
  expect(new Set(recording.spans.map((span) => span.traceId)).size).toBe(1);
  expect(recording.spans.every((span) => span.ended)).toBe(true);
  expect(request).toMatchObject({
    kind: "server",
    attributes: {},
    ended: true,
    endCount: 1,
  });
  expect(wire).toMatchObject({
    kind: "client",
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.operation.name": "add",
    },
  });
  expect(executor).toMatchObject({
    kind: "server",
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.operation.name": "add",
    },
  });
  expect(storage).toMatchObject({
    kind: "internal",
    attributes: {
      "takibi.collection.name": "posts",
      "takibi.storage.operation": "put",
      "takibi.document.id": expect.any(String),
    },
  });
  const attributes = JSON.stringify(recording.spans.map((span) => span.attributes));
  expect(attributes).not.toContain("hello");
  expect(attributes).not.toContain("tenant-a");
  expect(attributes).not.toContain("content-type");
});

test("global tracing registration uses a shared symbol-backed config", () => {
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);

  const config = (globalThis as Record<symbol, unknown>)[Symbol.for("takibi.tracingConfig")];
  expect(config).toMatchObject({
    tracer: recording.tracer,
    contextBackend: expect.any(Object),
  });

  registerGlobalTracer(undefined);
  expect((globalThis as Record<symbol, unknown>)[Symbol.for("takibi.tracingConfig")]).toMatchObject(
    {
      contextBackend: expect.any(Object),
    },
  );
});

test("B global registration matches C span names without collections options", async () => {
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  const production = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const handler = withSqliteTestBackend(production);
  await requestTakibi(handler, "http://fire.test/posts", {
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
  const handler = context
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );
  const added = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  expect(added.status).toBe(200);

  const request = spanNamed(recording.spans, "takibi.request");
  const resolve = child(recording.spans, request, "takibi.resolve");
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
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );

  const responsePromise = requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  await enteredResolve.promise;
  expect(recording.spans.map((span) => span.name)).toEqual(["takibi.request", "takibi.resolve"]);
  expect(spanNamed(recording.spans, "takibi.request").ended).toBe(false);
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
    const app = builder.defineCollections(
      testCase.collections ?? { posts: { schema: Post, accessPolicy: fullAccess } },
    );
    const handler = testCase.action
      ? app.actions({
          $: {
            boom: app
              .defineAction()
              .policy(fullAccess)
              .handler(() => {
                throw new Error("action-failed");
              }),
          },
        })
      : app.actions({});
    const object = new handler.DurableObject(
      createFakeDurableObjectState(
        testCase.failStorage
          ? createFailingDocumentWriteStorage()
          : createSqliteDurableObjectStorage(),
        { name: "tenant-a" },
      ),
      {},
    );
    const response = await requestTakibi(handler, testCase.path, testCase.init);
    const body = (await response.json()) as WireResponse;
    expect(body.ok, testCase.name).toBe(false);
    const failed =
      recording.spans.find((span) => span.name === testCase.name && span.status === "error") ??
      recording.spans.find((span) => span.name === testCase.name);
    expect(failed, testCase.name).toMatchObject({
      status: "error",
      exception: {
        name: expect.any(String),
        message: expect.any(String),
      },
      ended: true,
      endCount: 1,
    });
    if (testCase.action) {
      expect(failed).toMatchObject({
        attributes: {
          "takibi.action.name": "boom",
          "takibi.action.scope": "$",
        },
      });
    }
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
    const durable = testCase.failStorage
      ? { fetch: (request: Request) => object!.fetch(request) }
      : undefined;
    const builder = testCase.failStorage
      ? createTakibi()({
          resolve: () => ({ tenantId: "t" }),
          stub: () => durable as unknown as DurableObjectStub,
        })
      : testCase.context!();
    const app = builder.defineCollections(
      testCase.collections ?? { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    );
    const production = testCase.action
      ? app.actions({
          $: {
            boom: app
              .defineAction()
              .policy(fullAccess)
              .handler(() => {
                throw new Error("action-failed");
              }),
          },
        })
      : app.actions({});
    const handler =
      testCase.name === "takibi.wire" || testCase.failStorage
        ? production
        : withSqliteTestBackend(production);
    const object = testCase.failStorage
      ? new handler.DurableObject(
          createFakeDurableObjectState(createFailingDocumentWriteStorage(), { name: "t" }),
          {},
        )
      : undefined;
    const response = await requestTakibi(handler, testCase.path, testCase.init);
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
      expectedCode: "INVALID_DO_RESPONSE",
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
    })
      .defineCollections(
        { posts: { schema: Post, accessPolicy: fullAccess } },
        { [internalTracerKey]: recording.tracer },
      )
      .actions({});

    const response = await requestTakibi(handler, "http://fire.test/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "n" }),
    });
    expect(response.status, testCase.name).toBe(500);
    if (testCase.expectedCode) {
      await expect(response.clone().json(), testCase.name).resolves.toMatchObject({
        ok: false,
        error: { code: testCase.expectedCode },
      });
    }
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
  })
    .defineCollections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    )
    .actions({});

  const responsePromise = requestTakibi(handler, "http://fire.test/posts", {
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
  })
    .defineCollections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    )
    .actions({});

  const response = await requestTakibi(handler, "http://fire.test/posts", {
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
  const production = createTakibi()({ resolve: () => ({ tenantId: "t" }) })
    .defineCollections(
      { posts: { schema: Post, accessPolicy: none } },
      { [internalTracerKey]: recording.tracer },
    )
    .actions({});
  const handler = withSqliteTestBackend(production);
  const response = await requestTakibi(handler, "http://fire.test/posts", {
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
  const handler = context
    .defineCollections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      { [internalTracerKey]: recording.tracer },
    )
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );
  await requestTakibi(handler, "http://fire.test/posts", {
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
  const off = context
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const options = { [internalTracerKey]: recording.tracer };
  const on = context
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } }, options)
    .actions({});
  expectTypeOf(on).toEqualTypeOf(off);
  expectTypeOf(createClient<typeof on>("http://fire.test")).toEqualTypeOf(
    createClient<typeof off>("http://fire.test"),
  );
});

test("withSpan keeps the request path when the tracer adapter throws", async () => {
  registerGlobalTracer({
    startSpan() {
      throw new Error("adapter-start");
    },
    inject() {},
    extract() {
      return undefined;
    },
  });
  const production = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const added = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  expect(added.status).toBe(200);
});

test("withSpan swallows adapter errors on success and failure paths", async () => {
  registerGlobalTracer({
    startSpan() {
      return {
        context: {
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          traceFlags: 1,
        },
        runWithActiveContext: (fn) => fn(),
        recordException() {
          throw new Error("adapter-record");
        },
        setStatus() {
          throw new Error("adapter-status");
        },
        end() {
          throw new Error("adapter-end");
        },
      };
    },
    inject() {},
    extract() {
      return undefined;
    },
  });
  const production = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const added = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "n" }),
  });
  expect(added.status).toBe(200);
  const rejected = await requestTakibi(handler, "http://fire.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "" }),
  });
  expect(rejected.status).toBeGreaterThanOrEqual(400);
});

test("instrumentation contract stays off the public root", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };
  expect(JSON.stringify(pkg.dependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(JSON.stringify(pkg.peerDependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(pkg.exports?.["./instrumentation"]).toBe("./src/instrumentation.ts");

  type PublicModule = typeof import("takibi");
  type Hidden =
    | "internalTracerKey"
    | "registerGlobalTracer"
    | "registerTracingContextBackend"
    | "TracingContextBackend"
    | "createRecordingTracer"
    | "TakibiTracer"
    | "TakibiSpan"
    | "TakibiInstrumentation"
    | "CloudflareTakibiInstrumentation";
  expectTypeOf<Extract<Hidden, keyof PublicModule>>().toBeNever();
});
