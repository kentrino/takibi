import { requestTakibi } from "./helpers/request";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "../../takibi-testing/src/index";
import { createSqliteDurableObjectStorage } from "../../takibi-testing/src/sqlite-storage.server";
import { fullAccess } from "@takibi/takibi-policy";
import {
  createTakibi,
  formatTraceparent,
  internalTracerKey,
  registerGlobalTracer,
  registerTracingContextBackend,
  type LogEvent,
  type Logger,
  type DurableObjectFetchStub,
  type SpanAttributes,
  type SpanContext,
  type SpanException,
  type SpanKind,
  type SpanStatus,
  type TakibiTracer,
  type TracingContextBackend,
  type WireRequest,
  type WireResponse,
} from "../src";

const Post = z.object({ title: z.string() });

type RecordedSpan = {
  name: string;
  kind: SpanKind;
  attributes: SpanAttributes;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status?: SpanStatus;
  exceptions: SpanException[];
  endCount: number;
};

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

function createRecordingTracer(): { tracer: TakibiTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: TakibiTracer = {
    startSpan(spec, parent) {
      const context: SpanContext = {
        traceId: parent?.traceId ?? randomHex(16),
        spanId: randomHex(8),
        traceFlags: parent?.traceFlags ?? 1,
      };
      const recorded: RecordedSpan = {
        exceptions: [],
        endCount: 0,
        name: spec.name,
        kind: spec.kind,
        attributes: { ...spec.attributes },
        traceId: context.traceId,
        spanId: context.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
      };
      spans.push(recorded);
      return {
        context,
        runWithActiveContext: (fn) => fn(),
        recordException(exception) {
          recorded.exceptions.push(exception);
        },
        setStatus(status) {
          recorded.status = status;
        },
        end() {
          recorded.endCount++;
        },
      };
    },
    inject(headers, span) {
      headers.set("traceparent", formatTraceparent(span));
    },
    extract(headers) {
      const value = headers.get("traceparent");
      if (!value) return undefined;
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
      if (!match) return undefined;
      return {
        span: {
          traceId: match[1]!,
          spanId: match[2]!,
          traceFlags: Number.parseInt(match[3]!, 16),
          isRemote: true,
        },
        runWithActiveContext: (fn) => fn(),
      };
    },
  };
  return { tracer, spans };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function createApp(
  options: {
    events?: LogEvent[];
    resolve?: (input: { request: Request }) => { tenantId: string; marker?: string };
    stub?: () => DurableObjectFetchStub;
    seed?: () => Promise<Record<string, { title: string }>> | Record<string, { title: string }>;
    tracer?: TakibiTracer;
  } = {},
) {
  const context = createTakibi()({
    resolve:
      options.resolve ?? ((): { tenantId: string; marker?: string } => ({ tenantId: "tenant-a" })),
    ...(options.stub === undefined ? {} : { stub: options.stub }),
    ...(options.events === undefined
      ? {}
      : { logger: capturingLogger(options.events), logLevel: "debug" as const }),
  });
  const app = context.defineCollections(
    {
      posts: {
        schema: Post,
        accessPolicy: fullAccess,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      },
    },
    options.tracer === undefined ? {} : { [internalTracerKey]: options.tracer },
  );
  const echo = app
    .defineAction()
    .input(z.object({ marker: z.string() }))
    .policy(fullAccess)
    .handler(({ input, ctx }) => ({
      marker: input.marker,
      tenantId: ctx.tenantId,
      ...(typeof ctx.marker === "string" ? { requestMarker: ctx.marker } : {}),
    }));
  return app.actions({ $: { echo } });
}

async function doFetch(object: DurableObject, body: WireRequest, headers?: HeadersInit) {
  return object.fetch(
    new Request("https://takibi.internal/", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

test("DO fetch returns existing HTTP and wire results for CRUD and action", async () => {
  const handler = createApp();
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});

  const added = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "p1",
    input: { title: "from-do" },
    context: { tenantId: "tenant-a" },
  });
  expect(added.status).toBe(200);
  await expect(added.json<WireResponse>()).resolves.toMatchObject({
    ok: true,
    data: { id: "p1", title: "from-do" },
  });

  const missing = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "missing",
    context: { tenantId: "tenant-a" },
  });
  expect(missing.status).toBe(404);
  await expect(missing.json<WireResponse>()).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });

  const echoed = await doFetch(object, {
    kind: "action",
    scope: "$",
    name: "echo",
    input: { marker: "do-action" },
    context: { tenantId: "tenant-a" },
  });
  expect(echoed.status).toBe(200);
  await expect(echoed.json<WireResponse>()).resolves.toEqual({
    ok: true,
    data: { marker: "do-action", tenantId: "tenant-a" },
  });
});

test("DO batch keeps input order and continues after an item failure", async () => {
  const events: LogEvent[] = [];
  const handler = createApp({
    events,
    seed: () => ({ p1: { title: "one" } }),
  });
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});

  const response = await doFetch(object, {
    kind: "batch",
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "missing" },
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
    ],
    context: { tenantId: "tenant-a" },
  });
  expect(response.status).toBe(200);
  await expect(response.json<WireResponse>()).resolves.toEqual({
    ok: true,
    data: [
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "NOT_FOUND" }) }),
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ id: "p1", title: "one" }),
      }),
    ],
  });
  expect(events.filter(({ event }) => event === "takibi.executor")).toHaveLength(2);
  expect(events.filter(({ event }) => event === "takibi.error")).toHaveLength(1);
});

test("in-process handler entry matches DO single and batch results", async () => {
  const handler = withSqliteTestBackend(
    createApp({
      seed: () => ({ p1: { title: "one" } }),
    }),
  );

  const added = await requestTakibi(handler, "http://fire.test/posts/p2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "two" }),
  });
  expect(added.status).toBe(200);
  await expect(added.json()).resolves.toMatchObject({
    ok: true,
    data: { id: "p2", title: "two" },
  });

  const echoed = await requestTakibi(handler, "http://fire.test/$:echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marker: "local-action" }),
  });
  expect(echoed.status).toBe(200);
  await expect(echoed.json()).resolves.toEqual({
    ok: true,
    data: { marker: "local-action", tenantId: "tenant-a" },
  });

  const batch = await requestTakibi(handler, "http://fire.test/_batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "batch",
      items: [
        { kind: "collection", collection: "posts", operation: "get", id: "missing" },
        { kind: "collection", collection: "posts", operation: "get", id: "p1" },
      ],
    }),
  });
  expect(batch.status).toBe(200);
  await expect(batch.json()).resolves.toEqual({
    ok: true,
    data: [
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "NOT_FOUND" }) }),
      expect.objectContaining({ ok: true, data: expect.objectContaining({ id: "p1" }) }),
    ],
  });
});

test("Worker production dispatch resolves once and sends one stub fetch per Call", async () => {
  let resolveCalls = 0;
  const wires: WireRequest[] = [];
  const stub = {
    async fetch(request: Request) {
      wires.push((await request.json()) as WireRequest);
      return Response.json({
        ok: true,
        data: [
          {
            ok: false,
            error: {
              kind: "operation",
              code: "NOT_FOUND",
              status: 404,
              message: "Document not found",
            },
          },
          { ok: true, data: { id: "p1", title: "one" } },
        ],
      });
    },
  };
  const handler = createApp({
    resolve: () => {
      resolveCalls += 1;
      return { tenantId: "tenant-a" };
    },
    stub: () => stub,
  });

  const response = await requestTakibi(handler, "http://fire.test/_batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "batch",
      items: [
        { kind: "collection", collection: "posts", operation: "get", id: "missing" },
        { kind: "collection", collection: "posts", operation: "get", id: "p1" },
      ],
    }),
  });

  expect(response.status).toBe(200);
  expect(resolveCalls).toBe(1);
  expect(wires).toHaveLength(1);
  expect(wires[0]).toEqual({
    kind: "batch",
    context: { tenantId: "tenant-a" },
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "missing" },
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
    ],
  });
});

test("DO tenant mismatch and invalid wire fail before invocation", async () => {
  const events: LogEvent[] = [];
  const handler = createApp({ events });
  const object = new handler.DurableObject(
    fakeState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );

  const mismatch = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "cross",
    input: { title: "no" },
    context: { tenantId: "tenant-b" },
  });
  expect(mismatch.status).toBe(403);
  await expect(mismatch.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403, message: "Tenant mismatch" },
  });

  const invalid = await object.fetch(
    new Request("https://takibi.internal/", {
      method: "POST",
      body: "{",
    }),
  );
  expect(invalid.status).toBe(400);

  const later = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "cross",
    context: { tenantId: "tenant-a" },
  });
  expect(later.status).toBe(404);
  expect(events.filter(({ event }) => event === "takibi.executor")).toHaveLength(1);
});

test("DO fetch waits for ready and does not run inside a maintenance lease", async () => {
  let releaseSeed!: () => void;
  const seedGate = new Promise<void>((resolve) => {
    releaseSeed = resolve;
  });
  let markSeedStarted!: () => void;
  const seedStarted = new Promise<void>((resolve) => {
    markSeedStarted = resolve;
  });
  const handler = createApp({
    seed: async () => {
      markSeedStarted();
      await seedGate;
      return { p1: { title: "seeded" } };
    },
  });
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});

  let readySettled = false;
  const readyFetch = doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "p1",
    context: { tenantId: "tenant-a" },
  }).then((response) => {
    readySettled = true;
    return response;
  });
  await seedStarted;
  expect(readySettled).toBe(false);
  releaseSeed();
  const seeded = await readyFetch;
  expect(seeded.status).toBe(200);
  await expect(seeded.json<WireResponse>()).resolves.toMatchObject({
    ok: true,
    data: { id: "p1", title: "seeded" },
  });

  const snapshot = await object.$collections.$exportSnapshot();
  const locked = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "during-maintenance",
    input: { title: "blocked" },
    context: { tenantId: "tenant-a" },
  });
  expect(locked.status).toBe(503);
  await expect(locked.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "MAINTENANCE_LOCKED", status: 503 },
  });
  await snapshot.cancel();

  const created = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "after-maintenance",
    input: { title: "ok" },
    context: { tenantId: "tenant-a" },
  });
  expect(created.status).toBe(200);
  const blocked = await doFetch(object, {
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "during-maintenance",
    context: { tenantId: "tenant-a" },
  });
  expect(blocked.status).toBe(404);
});

test("executor spans stay one-per-invocation with DO server and in-process internal kinds", async () => {
  const recording = createRecordingTracer();
  const handler = createApp({
    seed: () => ({ p1: { title: "one" } }),
    tracer: recording.tracer,
  });
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});
  const parent: SpanContext = {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    traceFlags: 1,
  };

  const doResponse = await doFetch(
    object,
    {
      kind: "batch",
      items: [
        { kind: "collection", collection: "posts", operation: "get", id: "p1" },
        { kind: "collection", collection: "posts", operation: "get", id: "missing" },
      ],
      context: { tenantId: "tenant-a" },
    },
    { traceparent: formatTraceparent(parent) },
  );
  expect(doResponse.status).toBe(200);

  const doExecutors = recording.spans.filter((span) => span.name === "takibi.executor");
  expect(doExecutors).toHaveLength(2);
  expect(doExecutors.every((span) => span.kind === "server")).toBe(true);
  expect(doExecutors.every((span) => span.parentSpanId === parent.spanId)).toBe(true);
  expect(doExecutors.every((span) => span.traceId === parent.traceId)).toBe(true);

  const local = withSqliteTestBackend(handler);
  const localResponse = await requestTakibi(local, "http://fire.test/posts/p1");
  expect(localResponse.status).toBe(200);
  const localExecutors = recording.spans.filter(
    (span) => span.name === "takibi.executor" && span.kind === "internal",
  );
  expect(localExecutors).toHaveLength(1);
  const resolve = recording.spans.find((span) => span.name === "takibi.resolve");
  expect(localExecutors[0]?.parentSpanId).toBe(resolve?.spanId);
});

test("concurrent Calls on one executor keep distinct context and request tracing", async () => {
  const recording = createRecordingTracer();
  const handler = createApp({
    resolve: ({ request }) => ({
      tenantId: request.headers.get("x-test-tenant") ?? "missing",
      marker: request.headers.get("x-test-marker") ?? undefined,
    }),
    tracer: recording.tracer,
  });
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});
  const leftParent: SpanContext = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: 1,
  };
  const rightParent: SpanContext = {
    traceId: "33333333333333333333333333333333",
    spanId: "4444444444444444",
    traceFlags: 1,
  };

  const [leftDo, rightDo] = await Promise.all([
    doFetch(
      object,
      {
        kind: "action",
        scope: "$",
        name: "echo",
        input: { marker: "do-left" },
        context: { tenantId: "tenant-left" },
      },
      { traceparent: formatTraceparent(leftParent) },
    ),
    doFetch(
      object,
      {
        kind: "action",
        scope: "$",
        name: "echo",
        input: { marker: "do-right" },
        context: { tenantId: "tenant-right" },
      },
      { traceparent: formatTraceparent(rightParent) },
    ),
  ]);
  await expect(leftDo.json<WireResponse>()).resolves.toEqual({
    ok: true,
    data: { marker: "do-left", tenantId: "tenant-left" },
  });
  await expect(rightDo.json<WireResponse>()).resolves.toEqual({
    ok: true,
    data: { marker: "do-right", tenantId: "tenant-right" },
  });

  const doExecutors = recording.spans.filter((span) => span.name === "takibi.executor");
  expect(doExecutors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "server",
        traceId: leftParent.traceId,
        parentSpanId: leftParent.spanId,
      }),
      expect.objectContaining({
        kind: "server",
        traceId: rightParent.traceId,
        parentSpanId: rightParent.spanId,
      }),
    ]),
  );

  const local = withSqliteTestBackend(handler);
  const [leftLocal, rightLocal] = await Promise.all([
    requestTakibi(local, "http://fire.test/$:echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-tenant": "local-left",
        "x-test-marker": "req-left",
      },
      body: JSON.stringify({ marker: "local-left" }),
    }),
    requestTakibi(local, "http://fire.test/$:echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-tenant": "local-right",
        "x-test-marker": "req-right",
      },
      body: JSON.stringify({ marker: "local-right" }),
    }),
  ]);
  await expect(leftLocal.json()).resolves.toEqual({
    ok: true,
    data: { marker: "local-left", tenantId: "local-left", requestMarker: "req-left" },
  });
  await expect(rightLocal.json()).resolves.toEqual({
    ok: true,
    data: { marker: "local-right", tenantId: "local-right", requestMarker: "req-right" },
  });
});

test("tracing-disabled entrypoints still return existing results", async () => {
  const handler = createApp();
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});
  const local = withSqliteTestBackend(handler);
  const [doResponse, localResponse] = await Promise.all([
    doFetch(object, {
      kind: "action",
      scope: "$",
      name: "echo",
      input: { marker: "no-trace" },
      context: { tenantId: "tenant-a" },
    }),
    requestTakibi(local, "http://fire.test/$:echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marker: "no-trace" }),
    }),
  ]);
  expect(doResponse.status).toBe(200);
  expect(localResponse.status).toBe(200);
});

test.each([
  { kind: "collection", collection: "missing", operation: "get", id: "p1" },
  { kind: "action", scope: "$", name: "missing" },
  { kind: "action", scope: "$", name: "fail" },
] as const)("failed $kind invocation $name records its executor error", async (invocation) => {
  const privateMessage = "SQL failed at /internal/private.db";
  const events: LogEvent[] = [];
  const recording = createRecordingTracer();
  const app = createTakibi()({
    resolve: () => ({}),
    logger: capturingLogger(events),
    logLevel: "error",
  }).defineCollections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { [internalTracerKey]: recording.tracer },
  );
  const fail = app
    .defineAction()
    .policy(fullAccess)
    .handler(() => {
      throw new Error(privateMessage);
    });
  const handler = app.actions({ $: { fail } });
  const storage = createSqliteDurableObjectStorage();
  const object = new handler.DurableObject(fakeState(storage), {});
  const response = await doFetch(object, { ...invocation, context: {} });
  const expectedStatus = invocation.kind === "action" && invocation.name === "fail" ? 500 : 404;
  expect(response.status).toBe(expectedStatus);
  const wire = await response.json<WireResponse>();
  expect(wire).toMatchObject({ ok: false, error: { status: expectedStatus } });
  const executors = recording.spans.filter(({ name }) => name === "takibi.executor");
  expect(executors).toHaveLength(1);
  expect(executors[0]).toMatchObject({ status: { code: "error" }, endCount: 1 });
  expect(executors[0]!.exceptions).toHaveLength(1);
  if (!wire.ok && invocation.kind === "action" && invocation.name === "fail") {
    expect(wire.error).toMatchObject({
      code: "INTERNAL",
      message: "An unexpected error occurred.",
      status: 500,
    });
    expect(JSON.stringify(wire)).not.toContain(privateMessage);
    expect(executors[0]!.exceptions[0]!.message).toBe(privateMessage);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "takibi.error",
        message: privateMessage,
        errorCode: "INTERNAL",
        status: 500,
      }),
    );
  } else if (!wire.ok) {
    expect(executors[0]!.exceptions[0]!.message).toBe(wire.error.message);
  }
  storage.close();
});
