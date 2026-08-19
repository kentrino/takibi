import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageDriver } from "./types";

export const internalTracerKey: unique symbol = Symbol.for("takibi.internalTracer");

export type SpanContext = {
  traceId: string;
  spanId: string;
};

export type RecordedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: "ok" | "error";
  errorName?: string;
  ended: boolean;
};

export type TakibiSpan = {
  readonly context: SpanContext;
  recordError(err: unknown): void;
  end(): void;
};

export type TakibiTracer = {
  startSpan(name: string, parent?: SpanContext): TakibiSpan;
  forceFlush(): Promise<void>;
};

type TracingStore = {
  tracer: TakibiTracer;
  span?: SpanContext;
};

const tracingStore = new AsyncLocalStorage<TracingStore>();

let globalTracer: TakibiTracer | undefined;

export function registerGlobalTracer(tracer: TakibiTracer | undefined): void {
  globalTracer = tracer;
}

export function resolveTracer(options: object | undefined): TakibiTracer | undefined {
  const injected =
    options != null && internalTracerKey in options
      ? (options as { [internalTracerKey]?: TakibiTracer })[internalTracerKey]
      : undefined;
  return injected ?? globalTracer;
}

export function bindTracer<T>(tracer: TakibiTracer, fn: () => T): T {
  return tracingStore.run({ tracer }, fn);
}

export function injectTraceparent(headers: Headers): void {
  const span = tracingStore.getStore()?.span;
  if (!span) return;
  headers.set("traceparent", formatTraceparent(span));
}

export function extractSpanContext(headers: Headers): SpanContext | undefined {
  const value = headers.get("traceparent");
  if (!value) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(value);
  if (!match) return undefined;
  return { traceId: match[1]!, spanId: match[2]! };
}

export function formatTraceparent(span: SpanContext): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  parentOverride?: SpanContext,
): Promise<T> {
  const store = tracingStore.getStore();
  if (!store) return fn();
  const parent = parentOverride ?? store.span;
  const span = store.tracer.startSpan(name, parent);
  return tracingStore.run({ tracer: store.tracer, span: span.context }, async () => {
    try {
      const value = await fn();
      span.end();
      return value;
    } catch (err) {
      span.recordError(err);
      span.end();
      throw err;
    }
  });
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
      };
      const recorded: RecordedSpan = {
        name,
        traceId: context.traceId,
        spanId: context.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        status: "ok",
        ended: false,
      };
      spans.push(recorded);
      return {
        context,
        recordError(err) {
          recorded.status = "error";
          recorded.errorName = err instanceof Error ? err.name : "Error";
        },
        end() {
          recorded.ended = true;
        },
      };
    },
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
