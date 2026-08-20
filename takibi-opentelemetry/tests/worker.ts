import { AsyncLocalStorage } from "node:async_hooks";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { z } from "zod";
import { TakibiInstrumentation } from "../src/index";

class AsyncLocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(activeContext, () => fn.call(thisArg, ...args));
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

export type ExportedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
};

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
context.setGlobalContextManager(new AsyncLocalContextManager());
new TakibiInstrumentation().enable();

export async function flushAndReadSpans(): Promise<ExportedSpan[]> {
  await provider.forceFlush();
  return exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
  }));
}

const tracingHandler = createTakibi()({
  resolve: () => ({ tenantId: "unused-in-durable-object" }),
}).collections({
  posts: {
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
  },
});

export class TracingTestObject extends tracingHandler.DurableObject {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/exported-spans") {
      return Response.json(await flushAndReadSpans());
    }
    return super.fetch(request);
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TAKIBI_TRACING_TEST: DurableObjectNamespace;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("Takibi OpenTelemetry test worker");
  },
};
