import {
  context as otelContext,
  createContextKey,
  createTraceState,
  diag,
  propagation,
  ROOT_CONTEXT,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
  type SpanContext as OtelSpanContext,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";
import {
  registerGlobalTracer,
  registerTracingContextBackend,
  type SpanContext,
  type SpanKind as TakibiSpanKind,
  type SpanStatus,
  type TakibiTracer,
  type TracingContextBackend,
} from "@takibi/takibi/instrumentation";

const tracingStoreKey = createContextKey("takibi.tracing-store");
const contextManagerProbeKey = createContextKey("takibi.context-manager-probe");
let warnedMissingContextManager = false;

function contextManagerPropagates(): boolean {
  return (
    otelContext.with(otelContext.active().setValue(contextManagerProbeKey, true), () =>
      otelContext.active().getValue(contextManagerProbeKey),
    ) === true
  );
}
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
    startSpan(spec, parent) {
      const parentContext = parent
        ? trace.setSpanContext(otelContext.active(), toOtelSpanContext(parent))
        : otelContext.active();
      const span = tracer.startSpan(
        spec.name,
        {
          kind: toOtelSpanKind(spec.kind),
          ...(spec.attributes ? { attributes: spec.attributes } : {}),
        },
        parentContext,
      );
      const context = span.spanContext();
      return {
        context: fromOtelSpanContext(context),
        runWithActiveContext(fn) {
          return otelContext.with(trace.setSpan(parentContext, span), fn);
        },
        recordException(exception) {
          span.recordException(exception);
        },
        setStatus(status) {
          span.setStatus({
            code: toOtelStatusCode(status.code),
            ...(status.message === undefined ? {} : { message: status.message }),
          });
        },
        end() {
          span.end();
        },
      };
    },
    inject(headers, span) {
      const context = trace.setSpanContext(otelContext.active(), toOtelSpanContext(span));
      propagation.inject(context, headers, headersSetter);
    },
    extract(headers) {
      const tracingStore = otelContext.active().getValue(tracingStoreKey);
      const baseContext =
        tracingStore === undefined
          ? ROOT_CONTEXT
          : ROOT_CONTEXT.setValue(tracingStoreKey, tracingStore);
      const extractedContext = propagation.extract(baseContext, headers, headersGetter);
      const span = trace.getSpanContext(extractedContext);
      return {
        ...(span ? { span: fromOtelSpanContext(span) } : {}),
        runWithActiveContext(fn) {
          return otelContext.with(extractedContext, fn);
        },
      };
    },
  };
}

function toOtelSpanKind(kind: TakibiSpanKind): OtelSpanKind {
  return {
    internal: OtelSpanKind.INTERNAL,
    client: OtelSpanKind.CLIENT,
    server: OtelSpanKind.SERVER,
    producer: OtelSpanKind.PRODUCER,
    consumer: OtelSpanKind.CONSUMER,
  }[kind];
}

function toOtelStatusCode(code: SpanStatus["code"]): SpanStatusCode {
  return {
    unset: SpanStatusCode.UNSET,
    ok: SpanStatusCode.OK,
    error: SpanStatusCode.ERROR,
  }[code];
}

export class TakibiInstrumentation {
  enable(): void {
    if (!contextManagerPropagates() && !warnedMissingContextManager) {
      warnedMissingContextManager = true;
      diag.warn(
        "@takibi/takibi-opentelemetry: OpenTelemetry context is not propagating. Register a context manager before enable() or Takibi spans stay silent.",
      );
    }
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
