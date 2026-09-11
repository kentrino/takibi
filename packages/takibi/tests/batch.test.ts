import { requestTakibi } from "./helpers/request";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import { createTakibi, fullAccess, UnauthorizedError } from "../src/index";
import {
  internalTracerKey,
  registerGlobalTracer,
  registerTracingContextBackend,
  type TracingContextBackend,
} from "../src/tracing";
import { TAKIBI_ATTR } from "../src/otel-helper";
import type { LogEvent, Logger } from "../src/index";
import type { WireRequest } from "../src/protocol";
import { createRecordingTracer } from "./helpers/recording-tracer";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";

const Post = z.object({ title: z.string(), secret: z.boolean().default(false) });

function capturingLogger(events: LogEvent[]): Logger {
  return {
    log(event) {
      events.push(event);
    },
  };
}

function fakeState(storage: DurableObjectStorage, id: { name?: string } = {}): DurableObjectState {
  return {
    storage,
    id,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

function createSqliteHandler(
  options: {
    events?: LogEvent[];
    resolve?: () => { tenantId: string };
    policy?: typeof fullAccess;
  } = {},
) {
  let resolveCount = 0;
  const events = options.events ?? [];
  const production = createTakibi()({
    resolve: () => {
      resolveCount += 1;
      return options.resolve?.() ?? { tenantId: "tenant-a" };
    },
    logger: options.events ? capturingLogger(events) : undefined,
    logLevel: options.events ? "debug" : undefined,
  })
    .defineCollections({
      posts: {
        schema: Post,
        accessPolicy: options.policy ?? fullAccess,
        seed: () => ({
          p1: { title: "one", secret: false },
          p2: { title: "two", secret: false },
        }),
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  return { handler, resolveCount: () => resolveCount };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("SQLite test backend batch uses one public HTTP request, one resolve, and continues after item failure", async () => {
  const { handler, resolveCount } = createSqliteHandler();
  const client = createClient<typeof handler>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: (input, init) => requestTakibi(handler, input, init),
  });

  const missing = client.posts.get("missing");
  const found = client.posts.get("p1");
  const listed = client.posts.list();
  await vi.advanceTimersByTimeAsync(0);

  await expect(missing).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  await expect(found).resolves.toMatchObject({ ok: true, data: { id: "p1", title: "one" } });
  await expect(listed).resolves.toMatchObject({ ok: true });
  expect(resolveCount()).toBe(1);
});

test("malformed public batches execute no items and return 400", async () => {
  let policyCalls = 0;
  const production = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: {
        schema: Post,
        accessPolicy: () => {
          policyCalls += 1;
          return fullAccess;
        },
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);

  const rejected = await requestTakibi(handler, "http://fire.test/_batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "batch",
      items: [{ kind: "collection", collection: "posts", operation: "delete", id: "p1" }],
    }),
  });
  expect(rejected.status).toBe(400);
  expect(policyCalls).toBe(0);

  const empty = await requestTakibi(handler, "http://fire.test/_batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "batch", items: [] }),
  });
  expect(empty.status).toBe(400);
});

test("resolve failure is a top-level batch error and does not run items", async () => {
  const production = createTakibi()({
    resolve: () => {
      throw new UnauthorizedError("Sign in required");
    },
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof handler>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  const first = client.posts.get("p1");
  const second = client.posts.get("p2");
  await vi.advanceTimersByTimeAsync(0);
  const [left, right] = await Promise.all([first, second]);
  expect(left).toEqual(right);
  expect(left).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED", status: 401 } });
});

test("batch logs request/resolve once with size and executor once per item", async () => {
  const events: LogEvent[] = [];
  const { handler } = createSqliteHandler({ events });
  const client = createClient<typeof handler>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  const reads = Promise.all([client.posts.get("p1"), client.posts.get("p2")]);
  await vi.advanceTimersByTimeAsync(0);
  await reads;

  const requests = events.filter(({ event }) => event === "takibi.request");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    message: "started",
    method: "POST",
    path: "/_batch",
    batchSize: 2,
  });
  expect(events.filter(({ event }) => event === "takibi.resolve")).toHaveLength(1);
  expect(events.filter(({ event }) => event === "takibi.resolve")[0]).toMatchObject({
    batchSize: 2,
  });
  expect(events.filter(({ event }) => event === "takibi.executor")).toHaveLength(2);
  expect(
    events
      .filter(({ event }) => event === "takibi.executor")
      .map(({ collection, operation, documentId }) => `${collection}:${operation}:${documentId}`),
  ).toEqual(["posts:get:p1", "posts:get:p2"]);
});

test("single collection requests keep their HTTP status, envelope, and log fields", async () => {
  const events: LogEvent[] = [];
  const { handler } = createSqliteHandler({ events });
  const missing = await requestTakibi(handler, "http://fire.test/posts/missing");
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(events.filter(({ event }) => event === "takibi.request")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "takibi.request",
        method: "GET",
        path: "/posts/missing",
        collection: "posts",
        operation: "get",
        documentId: "missing",
      }),
    ]),
  );
  expect(events.every((event) => event.batchSize === undefined)).toBe(true);
});

test("Durable Object wire sends one batch fetch and continues after item failure", async () => {
  const wires: unknown[] = [];
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: () =>
      ({
        fetch: async (request: Request) => {
          wires.push(await request.clone().json());
          return object.fetch(request);
        },
      }) as unknown as DurableObjectStub,
  });
  const handler = context
    .defineCollections({
      posts: {
        schema: Post,
        accessPolicy: fullAccess,
        seed: () => ({ p1: { title: "one", secret: false } }),
      },
    })
    .actions({});
  const object = new handler.DurableObject(
    fakeState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );
  const client = createClient<typeof handler>("http://fire.test", {
    batch: { maxWaitMs: 0 },
    fetch: (input, init) => requestTakibi(handler, input, init),
  });

  const missing = client.posts.get("missing");
  const found = client.posts.get("p1");
  await vi.advanceTimersByTimeAsync(0);
  await expect(missing).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  await expect(found).resolves.toMatchObject({ ok: true, data: { id: "p1" } });
  expect(wires).toHaveLength(1);
  expect(wires[0]).toEqual({
    kind: "batch",
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "missing" },
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
    ],
    context: { tenantId: "tenant-a" },
  } satisfies WireRequest);
});

test("Durable Object batch wire rejects writes without executing items", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});
  const response = await object.fetch(
    new Request("https://takibi.internal/", {
      method: "POST",
      body: JSON.stringify({
        kind: "batch",
        items: [
          { kind: "collection", collection: "posts", operation: "add", input: { title: "x" } },
        ],
        context: { tenantId: "tenant-a" },
      }),
    }),
  );
  expect(response.status).toBe(400);
});

test("batch tracing records size on resolve/wire and invocation attributes per executor", async () => {
  const tracingStore = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();
  registerTracingContextBackend({
    getStore: () => tracingStore.getStore(),
    run: (store, fn) => tracingStore.run(store, fn),
  });
  const recording = createRecordingTracer();
  registerGlobalTracer(recording.tracer);
  try {
    const context = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      stub: () =>
        ({
          fetch: (request: Request) => object.fetch(request),
        }) as unknown as DurableObjectStub,
    });
    const handler = context
      .defineCollections(
        {
          posts: {
            schema: Post,
            accessPolicy: fullAccess,
            seed: () => ({ p1: { title: "one", secret: false } }),
          },
        },
        { [internalTracerKey]: recording.tracer },
      )
      .actions({});
    const object = new handler.DurableObject(
      fakeState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
      {},
    );
    const client = createClient<typeof handler>("http://fire.test", {
      batch: { maxWaitMs: 0 },
      fetch: (input, init) => requestTakibi(handler, input, init),
    });
    const reads = Promise.all([client.posts.get("p1"), client.posts.get("missing")]);
    await vi.advanceTimersByTimeAsync(0);
    await reads;

    const request = recording.spans.find((span) => span.name === "takibi.request");
    const resolve = recording.spans.find((span) => span.name === "takibi.resolve");
    const wire = recording.spans.find((span) => span.name === "takibi.wire");
    const executors = recording.spans.filter((span) => span.name === "takibi.executor");
    expect(request).toBeDefined();
    expect(resolve?.attributes).toMatchObject({ [TAKIBI_ATTR.batch.size]: 2 });
    expect(wire?.attributes).toMatchObject({ [TAKIBI_ATTR.batch.size]: 2 });
    expect(executors).toHaveLength(2);
    expect(executors.map((span) => span.attributes)).toEqual([
      {
        "takibi.collection.name": "posts",
        "takibi.operation.name": "get",
        "takibi.document.id": "p1",
      },
      {
        "takibi.collection.name": "posts",
        "takibi.operation.name": "get",
        "takibi.document.id": "missing",
      },
    ]);
  } finally {
    registerGlobalTracer(undefined);
    registerTracingContextBackend(undefined);
    tracingStore.disable();
  }
});
