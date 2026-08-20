import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { registerGlobalTracer, type SpanContext, type TakibiTracer } from "./tracing";

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
        context: { traceId: context.traceId, spanId: context.spanId },
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
    registerGlobalTracer(createOtelTakibiTracer());
  }

  disable(): void {
    registerGlobalTracer(undefined);
  }
}

function toOtelSpanContext(parent: SpanContext): {
  traceId: string;
  spanId: string;
  traceFlags: number;
} {
  return {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: 1,
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
