import {
  formatTraceparent,
  type SpanAttributes,
  type SpanContext,
  type SpanException,
  type SpanKind,
  type TakibiTracer,
} from "../../src/tracing";

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
    extract: extractW3cTraceContext,
  };
  return { tracer, spans };
}

function extractW3cTraceContext(headers: Headers): ReturnType<TakibiTracer["extract"]> {
  const value = headers.get("traceparent");
  if (!value) return undefined;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match) return undefined;
  const traceState = headers.get("tracestate") ?? undefined;
  return {
    span: {
      traceId: match[1]!,
      spanId: match[2]!,
      traceFlags: Number.parseInt(match[3]!, 16),
      ...(traceState ? { traceState } : {}),
      isRemote: true,
    },
    runWithActiveContext: (fn) => fn(),
  };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}
