import { Call, jsonResponseFromStatus } from "@takibi/takibi-worker-runtime-contract";
import type {
  CallFailureInput,
  CallTerminalEvent,
} from "@takibi/takibi-worker-runtime-contract";
import { withTracing } from "@takibi/takibi-utility";
import type { PublicRequest } from "../http";
import { requestLogFields, withLoggedSpan, type InternalLogger } from "../logging";
import { batchSpanAttributes, TAKIBI_SPAN } from "../otel-helper";
import type { WireResponse } from "../protocol";
import {
  activeSpanContext,
  bindTracer,
  resolveTracer,
  withSpan,
  type SpanContext,
  type TakibiTracer,
} from "../tracing";
import type { Executor } from "./executors";
import { assertSerializableContext, errorResponse, invocationFields } from "./runtime";
import type { ContextResolver, InternalCollectionsOptions } from "./types";

/**
 * Runtime Call context after resolve. App JSON-safe context stays in
 * `context`; resolve-span identity is only for executor/wire parentage.
 */
export type WorkerResolvedCall = {
  readonly context: Record<string, unknown>;
  readonly resolveSpan: SpanContext | undefined;
};

function batchSizeOf(decoded: PublicRequest): number | undefined {
  return decoded.kind === "batch" ? decoded.items.length : undefined;
}

/**
 * Worker HTTP adapters for one request. Logging, executor, and resolve-span
 * capture stay here; envelope progression stays on contract `Call`.
 */
export class WorkerCallAdapter {
  readonly #decode: () => Promise<PublicRequest>;
  readonly #resolve: ContextResolver<object, unknown>;
  readonly #execute: Executor;
  readonly #logger: InternalLogger | undefined;
  readonly #initial: unknown;
  readonly #tracer: TakibiTracer | undefined;
  readonly #startedAt: number;
  readonly #http: ReturnType<typeof requestLogFields>;

  constructor(input: {
    decode: () => Promise<PublicRequest>;
    resolve: ContextResolver<object, unknown>;
    execute: Executor;
    logger: InternalLogger | undefined;
    initial: unknown;
    tracer: TakibiTracer | undefined;
    startedAt: number;
    http: ReturnType<typeof requestLogFields>;
  }) {
    this.#decode = input.decode;
    this.#resolve = input.resolve;
    this.#execute = input.execute;
    this.#logger = input.logger;
    this.#initial = input.initial;
    this.#tracer = input.tracer;
    this.#startedAt = input.startedAt;
    this.#http = input.http;
  }

  decode(_request: Request): Promise<PublicRequest> {
    return this.#decode();
  }

  async onDecoded(input: { request: Request; decoded: PublicRequest }): Promise<void> {
    this.#logger?.emit({
      level: "info",
      event: "takibi.request",
      message: "started",
      ...this.#http,
      ...invocationFields(input.decoded),
    });
  }

  async resolveContext(input: {
    request: Request;
    decoded: PublicRequest;
  }): Promise<WorkerResolvedCall> {
    const context = await this.#resolve({
      request: input.request,
      context: this.#initial,
    });
    assertSerializableContext(context);
    return {
      context,
      resolveSpan: activeSpanContext(),
    };
  }

  dispatch(input: {
    request: Request;
    decoded: PublicRequest;
    context: WorkerResolvedCall;
  }): Promise<WireResponse> {
    return this.#execute({
      request: input.request,
      initial: this.#initial,
      ctx: input.context.context,
      invocation: input.decoded,
      tracer: this.#tracer,
      resolveSpan: input.context.resolveSpan,
    });
  }

  toResponse(input: { dispatched: WireResponse }): Response {
    return jsonResponseFromStatus(input.dispatched, Response);
  }

  toFailureResponse(
    failure: CallFailureInput<Request, PublicRequest, WorkerResolvedCall>,
  ): Response {
    return errorResponse(failure.error, this.#logger, failure.decoded, failure.request);
  }

  async onTerminal(event: CallTerminalEvent<Response, Request, PublicRequest>): Promise<void> {
    if (event.outcome !== "responded") return;
    this.#logger?.emit({
      level: "info",
      event: "takibi.request",
      message: "completed",
      ...this.#http,
      ...(event.decoded === undefined ? {} : invocationFields(event.decoded)),
      durationMs: performance.now() - this.#startedAt,
      status: event.response.status,
    });
  }
}

export async function serveDecodedCall<TInitial>(input: {
  request: Request;
  initial: unknown;
  decode: () => Promise<PublicRequest>;
  resolve: ContextResolver<object, TInitial>;
  execute: Executor;
  logger: InternalLogger | undefined;
  options: InternalCollectionsOptions;
}): Promise<Response> {
  const { request, initial, decode, resolve, execute, logger, options } = input;
  const tracer = resolveTracer(options);
  const serve = () =>
    withSpan({ name: TAKIBI_SPAN.request, kind: "server" }, async () => {
      const adapter = withTracing(
        new WorkerCallAdapter({
          decode,
          resolve: resolve as ContextResolver<object, unknown>,
          execute,
          logger,
          initial,
          tracer,
          startedAt: performance.now(),
          http: requestLogFields(request),
        }),
        {
          method: "resolveContext",
          span: TAKIBI_SPAN.resolve,
          kind: "internal",
          attributes: ({ decoded }) => {
            const batchSize = batchSizeOf(decoded);
            return batchSize === undefined ? undefined : batchSpanAttributes(batchSize);
          },
          run: (spec, fn, args) => {
            const batchSize = batchSizeOf(args[0].decoded);
            return withLoggedSpan(
              logger,
              spec,
              {
                event: "takibi.resolve",
                ...(batchSize === undefined ? {} : { batchSize }),
              },
              fn,
            );
          },
        },
      );
      return new Call(adapter).run(request);
    });
  return tracer ? bindTracer(tracer, serve) : serve();
}
