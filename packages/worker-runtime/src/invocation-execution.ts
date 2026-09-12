import type { ActionRegistry, CollectionsDef } from "@takibi/api";
import type { StorageDriver } from "@takibi/storage";
import {
  runInvocation,
  type BoundRunInvocation,
  type InvocationResult,
} from "@takibi/invocation-lifecycle";
import { defineContainer, inject, type DependencyGraph } from "tatenuki";
import {
  createTakibiInvocationAdapterFactories,
  INVOCATION_ADAPTER_KEYS,
  TAKIBI_INVOCATION_REGISTRATION_GRAPH,
  type TakibiAdapterMap,
} from "./adapter-map";
import { debugInvocationFields } from "./context/runtime";
import { invocationToWireResponse, invocationsToBatchWireResponse } from "./invocation-response";
import type {
  TakibiInvocationRuntime,
  TakibiInvocationTypeMap,
  TakibiWireInvocation,
} from "./invocation-type-map";
import { withLoggedSpan, type InternalLogger } from "./logging";
import { invocationSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import type { CollectionReadRequest, WireResponse } from "./protocol";
import {
  normalizeException,
  recordSpanException,
  type SpanContext,
  type SpanKind,
} from "./tracing";
import { jsonResponseFromStatus } from "./envelope/response";
import { createBatchTakibiCall, createSingleTakibiCall } from "./envelope/invocation";

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;
type Notified<TContext extends object, TServices> = InvocationResult<
  TakibiMap<TContext, TServices>
>;

export type LocalInvocationExecutionArgs<TContext extends object, TServices = unknown> = {
  collections: CollectionsDef<TContext>;
  storage: StorageDriver;
  registry: ActionRegistry;
  logger?: InternalLogger;
  services: TServices;
  spanKind: SpanKind;
  parentSpan?: SpanContext;
  request?: Request;
};

export type LocalExecution<TContext extends object = object, TServices = unknown> = {
  run(
    context: TContext,
    wireInvocation: TakibiWireInvocation,
  ): Promise<Notified<TContext, TServices>>;
  execute(context: TContext, wireInvocation: TakibiWireInvocation): Promise<WireResponse>;
  executeBatch(context: TContext, items: readonly CollectionReadRequest[]): Promise<WireResponse>;
  executeHttp(context: TContext, wireInvocation: TakibiWireInvocation): Promise<Response>;
  executeBatchHttp(context: TContext, items: readonly CollectionReadRequest[]): Promise<Response>;
};

/** Takibi invocation adapters plus local execution construction values. */
export type TakibiRuntimeAdapterMap<
  TContext extends object = object,
  TServices = unknown,
> = TakibiAdapterMap<TContext, TServices> & {
  invocationCoreRun: BoundRunInvocation<TakibiMap<TContext, TServices>>;
  localExecution: LocalExecution<TContext, TServices>;
  localSpanKind: SpanKind;
  localParentSpan: SpanContext | undefined;
  localRequest: Request | undefined;
};

function localInvocationRuntime<TContext extends object, TServices>(
  args: LocalInvocationExecutionArgs<TContext, TServices>,
): TakibiInvocationRuntime<TContext, TServices> {
  return {
    collections: args.collections,
    storage: args.storage,
    registry: args.registry,
    logger: args.logger,
    services: args.services,
  };
}

/** Executor span lives here only. Registration factories do not wrap `invocationRun`. */
function createInstrumentedInvocationRun<TContext extends object, TServices>(deps: {
  invocationCoreRun: BoundRunInvocation<TakibiMap<TContext, TServices>>;
  invocationRuntime: TakibiInvocationRuntime<TContext, TServices>;
  localSpanKind: SpanKind;
  localParentSpan: SpanContext | undefined;
}): BoundRunInvocation<TakibiMap<TContext, TServices>> {
  return ({ request, invocationRuntimeChecks }) =>
    withLoggedSpan(
      deps.invocationRuntime.logger,
      {
        name: TAKIBI_SPAN.executor,
        kind: deps.localSpanKind,
        attributes: invocationSpanAttributes(request.wireInvocation),
      },
      {
        event: "takibi.executor",
        ...debugInvocationFields(request.wireInvocation),
      },
      async (span) => {
        const result = await deps.invocationCoreRun({ request, invocationRuntimeChecks });
        if (result.settlement.outcome === "failed") {
          const { failure } = result.settlement;
          recordSpanException(
            span,
            failure.kind === "mapped"
              ? { name: failure.value.code, message: failure.value.message }
              : normalizeException(failure.error),
          );
        }
        return result;
      },
      deps.localParentSpan,
    );
}

type LocalSingleRequest<TContext> = Readonly<{
  context: TContext;
  wireInvocation: TakibiWireInvocation;
}>;

type LocalBatchRequest<TContext> = Readonly<{
  context: TContext;
  items: readonly CollectionReadRequest[];
}>;

function createLocalExecution<TContext extends object, TServices>(deps: {
  invocationRun: BoundRunInvocation<TakibiMap<TContext, TServices>>;
  invocationRuntime: TakibiInvocationRuntime<TContext, TServices>;
  localRequest: Request | undefined;
}): LocalExecution<TContext, TServices> {
  type Map = TakibiMap<TContext, TServices>;
  const run = (context: TContext, wireInvocation: TakibiWireInvocation) =>
    deps.invocationRun({ request: { wireInvocation, context } });
  const toSingleResponse = invocationToWireResponse(deps);
  const toBatchResponse = invocationsToBatchWireResponse(deps);
  // Local requests are already decoded wire payloads; the envelope runners own
  // the single and sequential batch loops.
  const executeSingle = createSingleTakibiCall<
    LocalSingleRequest<TContext>,
    LocalSingleRequest<TContext>,
    Map,
    WireResponse
  >({
    invocationRun: deps.invocationRun,
    callRuntimeChecks: undefined,
    callDecode: (request) => request,
    callResolveContext: ({ decoded }) => decoded.context,
    callGetWireInvocation: ({ decoded }) => decoded.wireInvocation,
    callToSingleResponse: ({ invocation }) => toSingleResponse({ invocation }),
  });
  const executeBatchCall = createBatchTakibiCall<
    LocalBatchRequest<TContext>,
    LocalBatchRequest<TContext>,
    Map,
    WireResponse
  >({
    invocationRun: deps.invocationRun,
    callRuntimeChecks: undefined,
    callDecode: (request) => request,
    callResolveContext: ({ decoded }) => decoded.context,
    callGetWireInvocations: ({ decoded }) => decoded.items,
    callToBatchResponse: ({ invocations }) => toBatchResponse({ invocations }),
  });
  const execute = (context: TContext, wireInvocation: TakibiWireInvocation) =>
    executeSingle({ context, wireInvocation });
  const executeBatch = (context: TContext, items: readonly CollectionReadRequest[]) =>
    executeBatchCall({ context, items });

  return {
    run,
    execute,
    executeBatch,
    executeHttp: async (context, invocation) =>
      jsonResponseFromStatus(await execute(context, invocation), Response),
    executeBatchHttp: async (context, items) =>
      jsonResponseFromStatus(await executeBatch(context, items), Response),
  };
}

export async function resolveLocalAdapterMap<TContext extends object, TServices = unknown>(
  args: LocalInvocationExecutionArgs<TContext, TServices>,
  overrides?: Partial<TakibiRuntimeAdapterMap<TContext, TServices>>,
): Promise<TakibiRuntimeAdapterMap<TContext, TServices>> {
  type Map = TakibiRuntimeAdapterMap<TContext, TServices>;
  type Invocation = TakibiMap<TContext, TServices>;

  const graph = {
    ...TAKIBI_INVOCATION_REGISTRATION_GRAPH,
    localSpanKind: [],
    localParentSpan: [],
    localRequest: [],
    invocationCoreRun: INVOCATION_ADAPTER_KEYS,
    invocationRun: ["invocationCoreRun", "invocationRuntime", "localSpanKind", "localParentSpan"],
    localExecution: ["invocationRun", "invocationRuntime", "localRequest"],
  } as const satisfies DependencyGraph<Map>;

  const builder = defineContainer<Map>()
    .graph(graph)
    .factories({
      ...createTakibiInvocationAdapterFactories<TContext, TServices>(),
      // runInvocation owns createPlan -> executePlan -> settle -> notify.
      invocationCoreRun: inject(runInvocation<Invocation>),
      // The executor span encloses that sequence and records failed settlement.
      invocationRun: createInstrumentedInvocationRun,
      // Run one invocation (or each batch item in order), then project the response.
      localExecution: createLocalExecution,
    });
  return (overrides === undefined ? builder : builder.override(overrides)).resolve({
    invocationRuntime: localInvocationRuntime(args),
    localSpanKind: args.spanKind,
    localParentSpan: args.parentSpan,
    localRequest: args.request,
  });
}

export async function resolveLocalExecution<TContext extends object, TServices = unknown>(
  args: LocalInvocationExecutionArgs<TContext, TServices>,
): Promise<LocalExecution<TContext, TServices>> {
  return (await resolveLocalAdapterMap(args)).localExecution;
}
