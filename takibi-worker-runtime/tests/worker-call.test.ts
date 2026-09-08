import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { serveDecodedCall } from "../src/context/worker-call";
import type { Executor, ExecutorInput } from "../src/context/executors";
import type { PublicRequest } from "../src/http";
import type { InternalLogger, LogEvent } from "../src/logging";
import { TAKIBI_SPAN } from "../src/otel-helper";
import type { WireResponse } from "../src/protocol";
import {
  formatTraceparent,
  internalTracerKey,
  registerGlobalTracer,
  registerTracingContextBackend,
  type SpanContext,
  type SpanException,
  type SpanKind,
  type SpanAttributes,
  type TakibiTracer,
  type TracingContextBackend,
} from "../src/tracing";

type RecordedSpan = {
  name: string;
  kind: SpanKind;
  attributes: SpanAttributes;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
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

function actionRequest(name: string): PublicRequest {
  return { kind: "action", scope: "$", name };
}

function okResponse(data: unknown): WireResponse {
  return { ok: true, data };
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
      spans.push({
        name: spec.name,
        kind: spec.kind,
        attributes: { ...spec.attributes },
        traceId: context.traceId,
        spanId: context.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
      });
      return {
        context,
        runWithActiveContext: (fn) => fn(),
        recordException(_exception: SpanException) {},
        setStatus() {},
        end() {},
      };
    },
    inject(headers, span) {
      headers.set("traceparent", formatTraceparent(span));
    },
    extract() {
      return undefined;
    },
  };
  return { tracer, spans };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function capturingLogger(events: LogEvent[]): InternalLogger {
  return {
    emit(event) {
      events.push(event);
    },
  };
}

test("WorkerCallAdapter #private fields still work when resolveContext is traced", async () => {
  const recording = createRecordingTracer();
  const response = await serveDecodedCall({
    request: new Request("https://takibi.test/$:echo", { method: "POST" }),
    initial: { tenantId: "tenant-a" },
    decode: async () => actionRequest("echo"),
    resolve: () => ({ tenantId: "tenant-a" }),
    execute: async (input) => {
      expect(input.initial).toEqual({ tenantId: "tenant-a" });
      expect(input.ctx).toEqual({ tenantId: "tenant-a" });
      expect(input.ctx).not.toHaveProperty("resolveSpan");
      return okResponse({ tenantId: input.ctx.tenantId });
    },
    logger: {
      emit() {
        throw new Error("logger failed");
      },
    },
    options: { [internalTracerKey]: recording.tracer },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, data: { tenantId: "tenant-a" } });
  expect(recording.spans.some((span) => span.name === TAKIBI_SPAN.resolve)).toBe(true);
});

test("decoded failure logging does not depend on onDecoded succeeding", async () => {
  const events: LogEvent[] = [];
  const logger: InternalLogger = {
    emit(event) {
      if (event.message === "started") {
        throw new Error("started observer failed");
      }
      events.push(event);
    },
  };
  const decoded = actionRequest("echo");
  const response = await serveDecodedCall({
    request: new Request("https://takibi.test/$:echo", { method: "POST" }),
    initial: { tenantId: "tenant-a" },
    decode: async () => decoded,
    resolve: () => {
      throw new Error("RESOLVE");
    },
    execute: async () => okResponse({ skipped: true }),
    logger,
    options: {},
  });

  expect(response.status).toBe(500);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "takibi.error",
        operation: "echo",
        method: "POST",
        path: "/$:echo",
      }),
    ]),
  );
});

test("concurrent Calls keep initial context, resolved context, and resolve spans apart", async () => {
  const recording = createRecordingTracer();
  const seen: ExecutorInput[] = [];
  const execute: Executor = async (input) => {
    seen.push(input);
    return okResponse({ tenantId: (input.ctx as { tenantId: string }).tenantId });
  };

  const left = serveDecodedCall({
    request: new Request("https://takibi.test/$:left", { method: "POST" }),
    initial: { tenantId: "left-initial" },
    decode: async () => actionRequest("left"),
    resolve: ({ context }) => ({
      tenantId: `${(context as { tenantId: string }).tenantId}-resolved`,
    }),
    execute,
    logger: undefined,
    options: { [internalTracerKey]: recording.tracer },
  });
  const right = serveDecodedCall({
    request: new Request("https://takibi.test/$:right", { method: "POST" }),
    initial: { tenantId: "right-initial" },
    decode: async () => actionRequest("right"),
    resolve: ({ context }) => ({
      tenantId: `${(context as { tenantId: string }).tenantId}-resolved`,
    }),
    execute,
    logger: undefined,
    options: { [internalTracerKey]: recording.tracer },
  });

  const [leftResponse, rightResponse] = await Promise.all([left, right]);
  expect(leftResponse.status).toBe(200);
  expect(rightResponse.status).toBe(200);
  await expect(leftResponse.json()).resolves.toEqual({
    ok: true,
    data: { tenantId: "left-initial-resolved" },
  });
  await expect(rightResponse.json()).resolves.toEqual({
    ok: true,
    data: { tenantId: "right-initial-resolved" },
  });

  expect(seen).toHaveLength(2);
  const leftExec = seen.find(
    (input) => input.invocation.kind === "action" && input.invocation.name === "left",
  );
  const rightExec = seen.find(
    (input) => input.invocation.kind === "action" && input.invocation.name === "right",
  );
  expect(leftExec?.initial).toEqual({ tenantId: "left-initial" });
  expect(rightExec?.initial).toEqual({ tenantId: "right-initial" });
  expect(leftExec?.ctx).toEqual({ tenantId: "left-initial-resolved" });
  expect(rightExec?.ctx).toEqual({ tenantId: "right-initial-resolved" });
  expect(leftExec?.ctx).not.toHaveProperty("resolveSpan");
  expect(rightExec?.ctx).not.toHaveProperty("resolveSpan");
  expect(leftExec?.resolveSpan?.spanId).toBeDefined();
  expect(rightExec?.resolveSpan?.spanId).toBeDefined();
  expect(leftExec?.resolveSpan?.spanId).not.toBe(rightExec?.resolveSpan?.spanId);

  const resolveSpans = recording.spans.filter((span) => span.name === TAKIBI_SPAN.resolve);
  expect(resolveSpans).toHaveLength(2);
  expect(resolveSpans.every((span) => span.kind === "internal")).toBe(true);
  expect(leftExec?.resolveSpan?.spanId).toBe(
    resolveSpans.find((span) => span.spanId === leftExec?.resolveSpan?.spanId)?.spanId,
  );
});

test("resolve batch attributes and request log fields stay on the existing events", async () => {
  const events: LogEvent[] = [];
  const recording = createRecordingTracer();
  const batch: PublicRequest = {
    kind: "batch",
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
      { kind: "collection", collection: "posts", operation: "get", id: "p2" },
    ],
  };
  const response = await serveDecodedCall({
    request: new Request("https://takibi.test/batch", { method: "POST" }),
    initial: { tenantId: "tenant-a" },
    decode: async () => batch,
    resolve: () => ({ tenantId: "tenant-a" }),
    execute: async () => okResponse({ items: [] }),
    logger: capturingLogger(events),
    options: { [internalTracerKey]: recording.tracer },
  });

  expect(response.status).toBe(200);
  expect(events.filter(({ event }) => event === "takibi.resolve")).toEqual([
    expect.objectContaining({ event: "takibi.resolve", batchSize: 2 }),
  ]);
  expect(events.filter(({ event }) => event === "takibi.request")).toEqual([
    expect.objectContaining({
      event: "takibi.request",
      message: "started",
      method: "POST",
      path: "/batch",
      batchSize: 2,
    }),
    expect.objectContaining({
      event: "takibi.request",
      message: "completed",
      method: "POST",
      path: "/batch",
      batchSize: 2,
    }),
  ]);
  const resolve = recording.spans.find((span) => span.name === TAKIBI_SPAN.resolve);
  const request = recording.spans.find((span) => span.name === TAKIBI_SPAN.request);
  expect(resolve?.kind).toBe("internal");
  expect(resolve?.attributes).toEqual({ "takibi.batch.size": 2 });
  expect(resolve?.parentSpanId).toBe(request?.spanId);
});
