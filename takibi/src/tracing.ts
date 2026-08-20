import type { StorageDriver } from "./types";

export const internalTracerKey: unique symbol = Symbol.for("takibi.internalTracer");

export type SpanContext = {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
  isRemote?: boolean;
};

export type RecordedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  traceFlags: number;
  parentSpanId?: string;
  status: "ok" | "error";
  errorName?: string;
  ended: boolean;
  endCount: number;
};

export type TakibiSpan = {
  readonly context: SpanContext;
  runWithActiveContext<T>(fn: () => T): T;
  recordError(err: unknown): void;
  end(): void;
};

export type TakibiTracer = {
  startSpan(name: string, parent?: SpanContext): TakibiSpan;
  inject(headers: Headers, span: SpanContext): void;
  extract(headers: Headers): SpanContext | undefined;
  forceFlush(): Promise<void>;
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
  name: string,
  fn: () => Promise<T>,
  parentOverride?: SpanContext,
): Promise<T> {
  const backend = contextBackend;
  if (!backend) return fn();
  const store = backend.getStore();
  if (!store) return fn();
  const parent = parentOverride ?? store.span;
  const span = store.tracer.startSpan(name, parent);
  return span.runWithActiveContext(() =>
    backend.run({ tracer: store.tracer, span: span.context }, async () => {
      try {
        const value = await fn();
        span.end();
        return value;
      } catch (err) {
        span.recordError(err);
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
    get: (resource, id) => withSpan("takibi.storage", () => next.get(resource, id)),
    put: (resource, doc) =>
      withSpan("takibi.storage", async () => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("storage-failed");
        }
        return next.put(resource, doc);
      }),
    delete: (resource, id) => withSpan("takibi.storage", () => next.delete(resource, id)),
    list: (resource, opts, plan) =>
      withSpan("takibi.storage", () => next.list(resource, opts, plan)),
    transaction: (callback) =>
      withSpan("takibi.storage", () => next.transaction((scoped) => callback(wrap(scoped)))),
  });
  return wrap(driver);
}

export function createRecordingTracer(): {
  tracer: TakibiTracer;
  spans: RecordedSpan[];
  didFlush: boolean;
  forceFlush(): Promise<void>;
} {
  const spans: RecordedSpan[] = [];
  const state = { didFlush: false };
  const tracer: TakibiTracer = {
    startSpan(name, parent) {
      const context: SpanContext = {
        traceId: parent?.traceId ?? randomHex(16),
        spanId: randomHex(8),
        traceFlags: parent?.traceFlags ?? 1,
        ...(parent?.traceState ? { traceState: parent.traceState } : {}),
      };
      const recorded: RecordedSpan = {
        name,
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
        recordError(err) {
          recorded.status = "error";
          recorded.errorName = err instanceof Error ? err.name : "Error";
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
    async forceFlush() {
      state.didFlush = true;
    },
  };
  return {
    tracer,
    spans,
    get didFlush() {
      return state.didFlush;
    },
    forceFlush: () => tracer.forceFlush(),
  };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}
