import { storageSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import type { StorageDriver } from "./types";

export const internalTracerKey: unique symbol = Symbol.for("takibi.internalTracer");

export type SpanContext = {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
  isRemote?: boolean;
};

export type SpanKind = "internal" | "client" | "server" | "producer" | "consumer";

export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

export type SpanSpec = {
  name: string;
  kind: SpanKind;
  attributes?: SpanAttributes;
};

export type SpanException = {
  name: string;
  message: string;
  stack?: string;
};

export type SpanStatus = {
  code: "unset" | "ok" | "error";
  message?: string;
};

export type RecordedSpan = {
  name: string;
  kind: SpanKind;
  attributes: SpanAttributes;
  traceId: string;
  spanId: string;
  traceFlags: number;
  parentSpanId?: string;
  status: "ok" | "error";
  statusMessage?: string;
  exception?: SpanException;
  ended: boolean;
  endCount: number;
};

export type TakibiSpan = {
  readonly context: SpanContext;
  runWithActiveContext<T>(fn: () => T): T;
  recordException(exception: SpanException): void;
  setStatus(status: SpanStatus): void;
  end(): void;
};

export type TakibiTracer = {
  startSpan(spec: SpanSpec, parent?: SpanContext): TakibiSpan;
  inject(headers: Headers, span: SpanContext): void;
  extract(headers: Headers): SpanContext | undefined;
};

type TracingStore = {
  tracer: TakibiTracer;
  span?: SpanContext;
};

export type TracingContextBackend = {
  getStore(): TracingStore | undefined;
  run<T>(store: TracingStore, fn: () => T): T;
};

let globalTracer: TakibiTracer | undefined;
let contextBackend: TracingContextBackend | undefined;

export function registerGlobalTracer(tracer: TakibiTracer | undefined): void {
  globalTracer = tracer;
}

export function registerTracingContextBackend(backend: TracingContextBackend | undefined): void {
  contextBackend = backend;
}

export function resolveTracer(options: object | undefined): TakibiTracer | undefined {
  const injected =
    options != null && internalTracerKey in options
      ? (options as { [internalTracerKey]?: TakibiTracer })[internalTracerKey]
      : undefined;
  return injected ?? globalTracer;
}

export function bindTracer<T>(tracer: TakibiTracer, fn: () => T): T {
  const backend = contextBackend;
  return backend ? backend.run({ tracer }, fn) : fn();
}

export function activeSpanContext(): SpanContext | undefined {
  return contextBackend?.getStore()?.span;
}

export function injectTraceparent(headers: Headers): void {
  const store = contextBackend?.getStore();
  if (!store?.span) return;
  store.tracer.inject(headers, store.span);
}

export function extractSpanContext(headers: Headers): SpanContext | undefined {
  const tracer = contextBackend?.getStore()?.tracer;
  if (!tracer) return undefined;
  return tracer.extract(headers);
}

function extractW3cSpanContext(headers: Headers): SpanContext | undefined {
  const value = headers.get("traceparent");
  if (!value) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match) return undefined;
  const traceState = headers.get("tracestate") ?? undefined;
  return {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: Number.parseInt(match[3]!, 16),
    ...(traceState ? { traceState } : {}),
    isRemote: true,
  };
}

export function formatTraceparent(span: SpanContext): string {
  const traceFlags = (span.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${span.traceId}-${span.spanId}-${traceFlags}`;
}

export async function withSpan<T>(
  spec: SpanSpec,
  fn: () => Promise<T>,
  parentOverride?: SpanContext,
): Promise<T> {
  const backend = contextBackend;
  if (!backend) return fn();
  const store = backend.getStore();
  if (!store) return fn();
  const parent = parentOverride ?? store.span;
  const span = store.tracer.startSpan(spec, parent);
  return span.runWithActiveContext(() =>
    backend.run({ tracer: store.tracer, span: span.context }, async () => {
      try {
        const value = await fn();
        span.end();
        return value;
      } catch (err) {
        const exception = normalizeException(err);
        span.recordException(exception);
        span.setStatus({ code: "error", message: exception.message });
        span.end();
        throw err;
      }
    }),
  );
}

let failNextWrite = false;

export function failNextStorageWrite(): void {
  failNextWrite = true;
}

export function tracedStorage(driver: StorageDriver): StorageDriver {
  const wrap = (next: StorageDriver): StorageDriver => ({
    get: (resource, id) =>
      withSpan(storageSpanSpec("get", resource, id), () => next.get(resource, id)),
    put: (resource, doc) =>
      withSpan(storageSpanSpec("put", resource, doc.id), async () => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("storage-failed");
        }
        return next.put(resource, doc);
      }),
    delete: (resource, id) =>
      withSpan(storageSpanSpec("delete", resource, id), () => next.delete(resource, id)),
    list: (resource, opts, plan) =>
      withSpan(storageSpanSpec("list", resource), () => next.list(resource, opts, plan)),
    transaction: (callback) =>
      withSpan(
        {
          name: TAKIBI_SPAN.storage,
          kind: "internal",
          attributes: storageSpanAttributes("transaction"),
        },
        () => next.transaction((scoped) => callback(wrap(scoped))),
      ),
  });
  return wrap(driver);
}

function storageSpanSpec(operation: string, collection: string, id?: string): SpanSpec {
  return {
    name: TAKIBI_SPAN.storage,
    kind: "internal",
    attributes: storageSpanAttributes(operation, collection, id),
  };
}

export function createRecordingTracer(): {
  tracer: TakibiTracer;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const tracer: TakibiTracer = {
    startSpan(spec, parent) {
      const context: SpanContext = {
        traceId: parent?.traceId ?? randomHex(16),
        spanId: randomHex(8),
        traceFlags: parent?.traceFlags ?? 1,
        ...(parent?.traceState ? { traceState: parent.traceState } : {}),
      };
      const recorded: RecordedSpan = {
        name: spec.name,
        kind: spec.kind,
        attributes: { ...spec.attributes },
        traceId: context.traceId,
        spanId: context.spanId,
        traceFlags: context.traceFlags,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        status: "ok",
        ended: false,
        endCount: 0,
      };
      spans.push(recorded);
      return {
        context,
        runWithActiveContext: (fn) => fn(),
        recordException(exception) {
          recorded.exception = { ...exception };
        },
        setStatus(status) {
          recorded.status = status.code === "error" ? "error" : "ok";
          recorded.statusMessage = status.message;
        },
        end() {
          recorded.ended = true;
          recorded.endCount += 1;
        },
      };
    },
    inject(headers, span) {
      headers.set("traceparent", formatTraceparent(span));
      if (span.traceState) headers.set("tracestate", span.traceState);
    },
    extract: extractW3cSpanContext,
  };
  return { tracer, spans };
}

function normalizeException(error: unknown): SpanException {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}
