import {
  registerGlobalTracer,
  registerTracingContextBackend,
  type SpanContext,
  type SpanException,
  type SpanSpec,
  type SpanStatus,
  type TakibiSpan,
  type TakibiTracer,
  type TracingContextBackend,
} from "takibi/instrumentation";

/**
 * Structural subset of Workers `tracing` / `ctx.tracing`. Pass the runtime
 * object from the `cloudflare:workers` module.
 */
export type CloudflareSpan = {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: boolean | number | string): void;
  end(): void;
};

export type CloudflareTracing = {
  enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: CloudflareSpan, ...args: A) => T,
    ...args: A
  ): T;
};

/**
 * Isolate-local tracer only. Parentage lives on Workers `enterSpan` async
 * context, so this backend does not keep a per-request span store.
 */
let enabledTracer: TakibiTracer | undefined;

const cloudflareContextBackend: TracingContextBackend = {
  getStore() {
    return enabledTracer === undefined ? undefined : { tracer: enabledTracer };
  },
  run(_store, fn) {
    return fn();
  },
};

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function createSpanContext(parent?: SpanContext): SpanContext {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    traceFlags: parent?.traceFlags ?? 1,
    ...(parent?.traceState ? { traceState: parent.traceState } : {}),
  };
}

function applySpecAttributes(span: CloudflareSpan, spec: SpanSpec): void {
  span.setAttribute("span.kind", spec.kind);
  for (const [key, value] of Object.entries(spec.attributes ?? {})) {
    span.setAttribute(key, value);
  }
}

function applyExceptionAttributes(span: CloudflareSpan, exception: SpanException): void {
  span.setAttribute("error.type", exception.name);
  span.setAttribute("error.message", exception.message);
  if (exception.stack) span.setAttribute("error.stack", exception.stack);
}

function applyStatusAttributes(span: CloudflareSpan, status: SpanStatus): void {
  span.setAttribute("otel.status_code", status.code);
  if (status.message) span.setAttribute("otel.status_description", status.message);
}

/**
 * Maps Takibi spans onto Workers native `enterSpan`. Parentage follows
 * JavaScript async context; Cloudflare does not yet expose span IDs, so
 * inject/extract stay no-ops and Durable Object traces rely on runtime
 * propagation.
 */
export function createCloudflareTakibiTracer(tracing: CloudflareTracing): TakibiTracer {
  return {
    startSpan(spec, parent) {
      const context = createSpanContext(parent);
      let nativeSpan: CloudflareSpan | undefined;
      const span: TakibiSpan = {
        context,
        runWithActiveContext(fn) {
          return tracing.enterSpan(spec.name, (cfSpan) => {
            nativeSpan = cfSpan;
            applySpecAttributes(cfSpan, spec);
            return fn();
          });
        },
        recordException(exception) {
          if (nativeSpan) applyExceptionAttributes(nativeSpan, exception);
        },
        setStatus(status) {
          if (nativeSpan) applyStatusAttributes(nativeSpan, status);
        },
        end() {
          nativeSpan?.end();
        },
      };
      return span;
    },
    inject() {
      // Workers propagates native trace context across Durable Object fetches.
    },
    extract() {
      return undefined;
    },
  };
}

/**
 * Registers Takibi's tracer against Workers native tracing. Call once per
 * isolate. Pass `tracing` from the `cloudflare:workers` module.
 */
export class CloudflareTakibiInstrumentation {
  enable(tracing: CloudflareTracing): void {
    enabledTracer = createCloudflareTakibiTracer(tracing);
    registerTracingContextBackend(cloudflareContextBackend);
    registerGlobalTracer(enabledTracer);
  }

  disable(): void {
    enabledTracer = undefined;
    registerGlobalTracer(undefined);
    registerTracingContextBackend(undefined);
  }
}
