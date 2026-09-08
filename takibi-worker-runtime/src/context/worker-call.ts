import { jsonResponseFromStatus, runCall } from "@takibi/takibi-worker-runtime-contract";
import type {
  CallAdapters,
  CallFailureInput,
  CallTerminalEvent,
} from "@takibi/takibi-worker-runtime-contract";
import { createClass, withTracing } from "@takibi/takibi-utility";
import type { PublicRequest } from "../http";
import { requestLogFields, withLoggedSpan, type InternalLogger } from "../logging";
import { batchSpanAttributes, TAKIBI_ATTR, TAKIBI_SPAN } from "../otel-helper";
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

type WorkerCallSurface = {
  decode: (request: Request) => Promise<PublicRequest>;
  onDecoded: (input: { request: Request; decoded: PublicRequest }) => Promise<void>;
  resolveContext: (input: {
    request: Request;
    decoded: PublicRequest;
  }) => Promise<WorkerResolvedCall>;
  dispatch: (input: {
    request: Request;
    decoded: PublicRequest;
    context: WorkerResolvedCall;
  }) => Promise<WireResponse>;
  toResponse: (input: {
    request: Request;
    decoded: PublicRequest;
    context: WorkerResolvedCall;
    dispatched: WireResponse;
  }) => Response;
  toFailureResponse: (
    failure: CallFailureInput<Request, PublicRequest, WorkerResolvedCall>,
  ) => Response;
  onTerminal: (event: CallTerminalEvent<Response, Request, PublicRequest>) => Promise<void>;
};

type WorkerCallCtor = {
  readonly decode: () => Promise<PublicRequest>;
  readonly resolve: ContextResolver<object, unknown>;
  readonly execute: Executor;
  readonly logger: InternalLogger | undefined;
  readonly initial: unknown;
  readonly tracer: TakibiTracer | undefined;
  readonly startedAt: number;
  readonly http: ReturnType<typeof requestLogFields>;
};

/**
 * Per-request Call adapters. Constructor binds resolver / executor / logger
 * and request-scoped inputs. Stage data moves through method args and the
 * resolved-call return value, not mutable instance fields.
 */
export const WorkerCall = createClass<WorkerCallSurface>()
  .constructor<WorkerCallCtor>({
    runtimeCheck: true,
  })
  .define("decode", (deps) => deps.decode())
  .define("onDecoded", async (deps, { decoded }) => {
    deps.logger?.emit({
      level: "info",
      event: "takibi.request",
      message: "started",
      ...deps.http,
      ...invocationFields(decoded),
    });
  })
  .define("resolveContext", async (deps, { request }) => {
    const context = await deps.resolve({
      request,
      context: deps.initial,
    });
    assertSerializableContext(context);
    return {
      context,
      resolveSpan: activeSpanContext(),
    };
  })
  .define("dispatch", (deps, { request, decoded, context }) =>
    deps.execute({
      request,
      initial: deps.initial,
      ctx: context.context,
      invocation: decoded,
      tracer: deps.tracer,
      resolveSpan: context.resolveSpan,
    }),
  )
  .define("toResponse", (_deps, { dispatched }) => jsonResponseFromStatus(dispatched, Response))
  .define("toFailureResponse", (deps, failure) =>
    errorResponse(failure.error, deps.logger, failure.decoded, failure.request),
  )
  .define("onTerminal", async (deps, event) => {
    if (event.outcome !== "responded") return;
    deps.logger?.emit({
      level: "info",
      event: "takibi.request",
      message: "completed",
      ...deps.http,
      ...(event.decoded === undefined ? {} : invocationFields(event.decoded)),
      durationMs: performance.now() - deps.startedAt,
      status: event.response.status,
    });
  });

function resolveBatchSize(decoded: PublicRequest): number | undefined {
  return decoded.kind === "batch" ? decoded.items.length : undefined;
}

function traceWorkerCall(
  instance: WorkerCallSurface,
  logger: InternalLogger | undefined,
): CallAdapters<Request, PublicRequest, WorkerResolvedCall, Response, WireResponse> {
  return withTracing<WorkerCallSurface, "resolveContext">(instance, {
    method: "resolveContext",
    span: TAKIBI_SPAN.resolve,
    kind: "internal",
    attributes: ({ decoded }) => {
      const batchSize = resolveBatchSize(decoded);
      return batchSize === undefined ? undefined : batchSpanAttributes(batchSize);
    },
    run: (spec, fn) => {
      const batchSize = spec.attributes?.[TAKIBI_ATTR.batch.size];
      return withLoggedSpan(
        logger,
        spec,
        {
          event: "takibi.resolve",
          ...(typeof batchSize === "number" ? { batchSize } : {}),
        },
        fn,
      );
    },
  });
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
      const adapters = traceWorkerCall(
        WorkerCall.new({
          decode,
          resolve: resolve as ContextResolver<object, unknown>,
          execute,
          logger,
          initial,
          tracer,
          startedAt: performance.now(),
          http: requestLogFields(request),
        }),
        logger,
      );
      return runCall(request, adapters);
    });
  return tracer ? bindTracer(tracer, serve) : serve();
}
