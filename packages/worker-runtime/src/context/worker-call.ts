import { Call, ENVELOPE_ADAPTER_GRAPH, type EnvelopeAdapterMap } from "../envelope/call";
import { jsonResponseFromStatus } from "../envelope/response";
import { withTracing } from "@takibi/utility";
import { defineContainer, inject, type DependencyGraph } from "tatenuki";
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
export type WorkerResolvedCall<TCtx extends object = object> = {
  readonly context: TCtx & Record<string, unknown>;
  readonly resolveSpan: SpanContext | undefined;
};

export type WorkerCall<TCtx extends object = object> = EnvelopeAdapterMap<
  Request,
  PublicRequest,
  WorkerResolvedCall<TCtx>,
  Response,
  WireResponse
>["call"];

/**
 * Envelope Call map plus request-scoped construction values. Resolving this
 * graph does not require storage or invocation-execution adapters.
 */
export type WorkerEnvelopeAdapterMap<
  TInitial = unknown,
  TCtx extends object = object,
> = EnvelopeAdapterMap<Request, PublicRequest, WorkerResolvedCall<TCtx>, Response, WireResponse> & {
  request: Request;
  initial: TInitial;
  requestDecoder: () => Promise<PublicRequest>;
  contextResolver: ContextResolver<TCtx, TInitial>;
  execute: Executor<TInitial, TCtx>;
  logger: InternalLogger | undefined;
  tracer: TakibiTracer | undefined;
  clock: () => number;
  startedAt: number;
  http: ReturnType<typeof requestLogFields>;
};

type Map<TInitial = unknown, TCtx extends object = object> = WorkerEnvelopeAdapterMap<
  TInitial,
  TCtx
>;

export const WORKER_ENVELOPE_ADAPTER_GRAPH = {
  ...ENVELOPE_ADAPTER_GRAPH,
  request: [],
  initial: [],
  requestDecoder: [],
  contextResolver: [],
  execute: [],
  logger: [],
  tracer: [],
  clock: [],
  http: ["request"],
  startedAt: ["clock"],
  callDecode: ["requestDecoder"],
  callResolveContext: ["contextResolver", "initial", "logger"],
  callDispatch: ["execute", "initial", "tracer"],
  callToResponse: [],
  callToFailureResponse: ["logger"],
  callOnDecoded: ["logger", "http"],
  callOnTerminal: ["logger", "http", "startedAt", "clock"],
} as const satisfies DependencyGraph<Map>;

function batchSizeOf(decoded: PublicRequest): number | undefined {
  return decoded.kind === "batch" ? decoded.items.length : undefined;
}

function createCallResolveContext<TInitial, TCtx extends object>({
  contextResolver,
  initial,
  logger,
}: Pick<Map<TInitial, TCtx>, "contextResolver" | "initial" | "logger">): Map<
  TInitial,
  TCtx
>["callResolveContext"] {
  const adapter = {
    async resolveContext(input: {
      request: Request;
      decoded: PublicRequest;
    }): Promise<WorkerResolvedCall<TCtx>> {
      const context = await contextResolver({
        request: input.request,
        context: initial,
      });
      assertSerializableContext(context);
      return {
        context,
        resolveSpan: activeSpanContext(),
      };
    },
  };
  const traced = withTracing(adapter, {
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
  });
  return (input) => traced.resolveContext(input);
}

export type ResolveWorkerEnvelopeArgs<TInitial = unknown, TCtx extends object = object> = {
  request: Request;
  initial: TInitial;
  decode: () => Promise<PublicRequest>;
  resolve: ContextResolver<TCtx, TInitial>;
  execute: Executor<TInitial, TCtx>;
  logger: InternalLogger | undefined;
  options: InternalCollectionsOptions;
  tracer?: TakibiTracer | undefined;
  clock?: () => number;
};

export async function resolveWorkerEnvelopeMap<TInitial, TCtx extends object>(
  args: ResolveWorkerEnvelopeArgs<TInitial, TCtx>,
  overrides?: Partial<WorkerEnvelopeAdapterMap<TInitial, TCtx>>,
): Promise<WorkerEnvelopeAdapterMap<TInitial, TCtx>> {
  const values = {
    request: args.request,
    initial: args.initial,
    requestDecoder: args.decode,
    contextResolver: args.resolve,
    execute: args.execute,
    logger: args.logger,
    tracer: args.tracer ?? resolveTracer(args.options),
    clock: args.clock ?? (() => performance.now()),
  };
  const builder = defineContainer<Map<TInitial, TCtx>>()
    .graph(WORKER_ENVELOPE_ADAPTER_GRAPH)
    .factories({
      http: ({ request }) => requestLogFields(request),
      startedAt: ({ clock }) => clock(),
      // Call.run owns execution order; the graph only constructs these slots.
      // Success: decode -> started log -> resolve span -> dispatch -> response -> terminal.
      callDecode:
        ({ requestDecoder }) =>
        (_request) =>
          requestDecoder(),
      callOnDecoded:
        ({ logger, http }) =>
        async (input) => {
          logger?.emit({
            level: "info",
            event: "takibi.request",
            message: "started",
            ...http,
            ...invocationFields(input.decoded),
          });
        },
      callResolveContext: createCallResolveContext<TInitial, TCtx>,
      callDispatch:
        ({ execute, initial, tracer }) =>
        (input) =>
          execute({
            request: input.request,
            initial,
            ctx: input.context.context,
            invocation: input.decoded,
            tracer,
            resolveSpan: input.context.resolveSpan,
          }),
      callToResponse: () => (input) => jsonResponseFromStatus(input.dispatched, Response),
      // Stage failure: error response (with error log) -> terminal.
      // Decode failure skips the started log. A failing converter rejects once.
      callToFailureResponse:
        ({ logger }) =>
        (failure) =>
          errorResponse(failure.error, logger, failure.decoded, failure.request),
      // Call isolates observer failures. Only a response emits the completed log.
      callOnTerminal:
        ({ logger, http, startedAt, clock }) =>
        async (event) => {
          if (event.outcome !== "responded") return;
          logger?.emit({
            level: "info",
            event: "takibi.request",
            message: "completed",
            ...http,
            ...(event.decoded === undefined ? {} : invocationFields(event.decoded)),
            durationMs: clock() - startedAt,
            status: event.response.status,
          });
        },
      call: inject(Call<Request, PublicRequest, WorkerResolvedCall<TCtx>, Response, WireResponse>),
    });
  return (overrides === undefined ? builder : builder.override(overrides)).resolve(values);
}

export async function serveDecodedCall<TInitial, TCtx extends object>(
  input: ResolveWorkerEnvelopeArgs<TInitial, TCtx>,
): Promise<Response> {
  const tracer = input.tracer ?? resolveTracer(input.options);
  const serve = () =>
    withSpan({ name: TAKIBI_SPAN.request, kind: "server" }, async () => {
      const { call } = await resolveWorkerEnvelopeMap({ ...input, tracer });
      return call.run(input.request);
    });
  return tracer ? bindTracer(tracer, serve) : serve();
}
