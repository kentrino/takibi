import {
  context as otelContext,
  createContextKey,
  createTraceState,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type SpanContext as OtelSpanContext,
  type TextMapGetter,
  type TextMapSetter,
  type TracerProvider,
} from "@opentelemetry/api";
import {
  registerGlobalTracer,
  registerTracingContextBackend,
  type SpanContext,
  type TakibiTracer,
  type TracingContextBackend,
} from "./tracing";

const tracingStoreKey = createContextKey("takibi.tracing-store");
const otelContextBackend: TracingContextBackend = {
  getStore() {
    return otelContext.active().getValue(tracingStoreKey) as ReturnType<
      TracingContextBackend["getStore"]
    >;
  },
  run(store, fn) {
    return otelContext.with(otelContext.active().setValue(tracingStoreKey, store), fn);
  },
};

const headersSetter: TextMapSetter<Headers> = {
  set(carrier, key, value) {
    carrier.set(key, value);
  },
};

const headersGetter: TextMapGetter<Headers> = {
  get(carrier, key) {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier) {
    return [...carrier.keys()];
  },
};

export function createOtelTakibiTracer(name = "takibi"): TakibiTracer {
  const tracer = trace.getTracer(name);
  return {
    startSpan(spanName, parent) {
      const parentContext = parent
        ? trace.setSpanContext(otelContext.active(), toOtelSpanContext(parent))
        : otelContext.active();
      const span = tracer.startSpan(spanName, undefined, parentContext);
      const context = span.spanContext();
      return {
        context: fromOtelSpanContext(context),
        runWithActiveContext(fn) {
          return otelContext.with(trace.setSpan(parentContext, span), fn);
        },
        recordError(err) {
          const error = err instanceof Error ? err : new Error(String(err));
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        },
        end() {
          span.end();
        },
      };
    },
    inject(headers, span) {
      const context = trace.setSpanContext(ROOT_CONTEXT, toOtelSpanContext(span));
      propagation.inject(context, headers, headersSetter);
    },
    extract(headers) {
      const context = propagation.extract(ROOT_CONTEXT, headers, headersGetter);
      const span = trace.getSpanContext(context);
      return span ? fromOtelSpanContext(span) : undefined;
    },
    async forceFlush() {
      const provider = unwrapTracerProvider(trace.getTracerProvider());
      if (typeof provider.forceFlush === "function") {
        await provider.forceFlush();
      }
    },
  };
}

export class TakibiInstrumentation {
  enable(): void {
    registerTracingContextBackend(otelContextBackend);
    registerGlobalTracer(createOtelTakibiTracer());
  }

  disable(): void {
    registerGlobalTracer(undefined);
    registerTracingContextBackend(undefined);
  }
}

function toOtelSpanContext(parent: SpanContext): OtelSpanContext {
  return {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.traceFlags,
    ...(parent.traceState ? { traceState: createTraceState(parent.traceState) } : {}),
    ...(parent.isRemote === undefined ? {} : { isRemote: parent.isRemote }),
  };
}

function fromOtelSpanContext(context: OtelSpanContext): SpanContext {
  const traceState = context.traceState?.serialize();
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags,
    ...(traceState ? { traceState } : {}),
    ...(context.isRemote === undefined ? {} : { isRemote: context.isRemote }),
  };
}

function unwrapTracerProvider(provider: TracerProvider): TracerProvider & {
  forceFlush?: () => Promise<void>;
} {
  if ("getDelegate" in provider && typeof provider.getDelegate === "function") {
    return provider.getDelegate() as TracerProvider & { forceFlush?: () => Promise<void> };
  }
  return provider;
}
