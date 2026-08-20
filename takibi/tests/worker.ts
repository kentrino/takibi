import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { createTraceState, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { createTakibi, fullAccess } from "../src/index";
import {
  formatTraceparent,
  internalTracerKey,
  registerTracingContextBackend,
  type SpanContext,
  type TakibiTracer,
  type TracingContextBackend,
} from "../src/tracing";

const tracingExporter = new InMemorySpanExporter();
const tracingProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(tracingExporter)],
});
const otelTracer = tracingProvider.getTracer("takibi-do-test");
const tracingStorage = new AsyncLocalStorage<ReturnType<TracingContextBackend["getStore"]>>();
const tracingContextBackend: TracingContextBackend = {
  getStore: () => tracingStorage.getStore(),
  run: (store, fn) => tracingStorage.run(store, fn),
};
const durableObjectTracer: TakibiTracer = {
  startSpan(name, parent) {
    const parentContext = parent
      ? trace.setSpanContext(ROOT_CONTEXT, {
          traceId: parent.traceId,
          spanId: parent.spanId,
          traceFlags: parent.traceFlags,
          ...(parent.traceState ? { traceState: createTraceState(parent.traceState) } : {}),
          ...(parent.isRemote === undefined ? {} : { isRemote: parent.isRemote }),
        })
      : ROOT_CONTEXT;
    const span = otelTracer.startSpan(name, undefined, parentContext);
    const spanContext = span.spanContext();
    return {
      context: {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        traceFlags: spanContext.traceFlags,
      },
      runWithActiveContext: (fn) => fn(),
      recordError: (error) => span.recordException(error as Error),
      end: () => span.end(),
    };
  },
  inject(headers, span) {
    headers.set("traceparent", formatTraceparent(span));
    if (span.traceState) headers.set("tracestate", span.traceState);
  },
  extract(headers) {
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
      headers.get("traceparent") ?? "",
    );
    if (!match) return undefined;
    const extracted: SpanContext = {
      traceId: match[1]!,
      spanId: match[2]!,
      traceFlags: Number.parseInt(match[3]!, 16),
      isRemote: true,
    };
    const traceState = headers.get("tracestate");
    return traceState ? { ...extracted, traceState } : extracted;
  },
  forceFlush: () => tracingProvider.forceFlush(),
};

const tracingHandler = createTakibi()({
  resolve: () => ({ tenantId: "unused-in-durable-object" }),
}).collections(
  {
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  },
  { [internalTracerKey]: durableObjectTracer },
);
const TracingDurableObject = tracingHandler.DurableObject;

export class StorageTestObject extends DurableObject<Cloudflare.Env> {
  ping(): string {
    return "ok";
  }
}

export class TracingTestObject extends TracingDurableObject {
  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    registerTracingContextBackend(tracingContextBackend);
    super(state, env);
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__test/exported-spans") {
      return super.fetch(request);
    }
    return Response.json(await this.#exportedSpans());
  }

  async #exportedSpans(): Promise<
    Array<{
      name: string;
      traceId: string;
      spanId: string;
      parentSpanId?: string;
    }>
  > {
    await tracingProvider.forceFlush();
    return tracingExporter.getFinishedSpans().map((span) => ({
      name: span.name,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    }));
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TAKIBI_STORAGE_TEST: DurableObjectNamespace<StorageTestObject>;
      TAKIBI_TRACING_TEST: DurableObjectNamespace;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("Takibi storage test worker");
  },
};
