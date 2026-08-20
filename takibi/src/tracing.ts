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

export type TakibiSpan = {
  readonly context: SpanContext;
  runWithActiveContext<T>(fn: () => T): T;
  recordException(exception: SpanException): void;
  setStatus(status: SpanStatus): void;
  end(): void;
};

export type ExtractedTraceContext = {
  readonly span?: SpanContext;
  runWithActiveContext<T>(fn: () => T): T;
};

export type TakibiTracer = {
  startSpan(spec: SpanSpec, parent?: SpanContext): TakibiSpan;
  inject(headers: Headers, span: SpanContext): void;
  extract(headers: Headers): ExtractedTraceContext | undefined;
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

export function extractTraceContext(headers: Headers): ExtractedTraceContext | undefined {
  const tracer = contextBackend?.getStore()?.tracer;
  if (!tracer) return undefined;
  return tracer.extract(headers);
}

export function formatTraceparent(span: SpanContext): string {
  const traceFlags = (span.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${span.traceId}-${span.spanId}-${traceFlags}`;
}

function ignoreAdapterError(fn: () => void): void {
  try {
    fn();
  } catch {
    // Tracing adapters are best-effort and must not take down the request path.
  }
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
  let span: TakibiSpan;
  try {
    span = store.tracer.startSpan(spec, parent);
  } catch {
    return fn();
  }
  return span.runWithActiveContext(() =>
    backend.run({ tracer: store.tracer, span: span.context }, async () => {
      try {
        return await fn();
      } catch (err) {
        const exception = normalizeException(err);
        ignoreAdapterError(() => span.recordException(exception));
        ignoreAdapterError(() => span.setStatus({ code: "error", message: exception.message }));
        throw err;
      } finally {
        ignoreAdapterError(() => span.end());
      }
    }),
  );
}

export function tracedStorage(driver: StorageDriver): StorageDriver {
  const wrap = (next: StorageDriver): StorageDriver => ({
    get: (resource, id) =>
      withSpan(storageSpanSpec("get", resource, id), () => next.get(resource, id)),
    put: (resource, doc) =>
      withSpan(storageSpanSpec("put", resource, doc.id), () => next.put(resource, doc)),
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
