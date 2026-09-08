import type { ActionRegistry, CollectionsDef } from "@takibi/takibi-api";
import type { StorageDriver } from "@takibi/takibi-storage";
import {
  createBatchTakibiCall,
  createSingleTakibiCall,
  decodeLocalCallRequest,
  getLocalCallWireInvocation,
  getLocalCallWireInvocations,
  jsonResponseFromStatus,
  localBatchCall,
  localSingleCall,
  resolveLocalCallContext,
  RUNTIME_ADAPTER_GRAPH,
  runInvocation,
  type BoundRunInvocation,
  type InvocationResult,
  type LocalCallRequest,
  type LocalCallTypeMap,
  type RuntimeAdapterMap,
  type TakibiCall,
} from "@takibi/takibi-worker-runtime-contract";
import { defineContainer, inject, type DependencyGraph } from "tatenuki";
import {
  createTakibiInvocationAdapterFactories,
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

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;
type Notified<TContext extends object, TServices> = InvocationResult<
  TakibiMap<TContext, TServices>
>;

export type LocalCallInput<TContext extends object> = LocalCallRequest<
  TContext,
  TakibiWireInvocation,
  CollectionReadRequest
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

type LocalCallType<TContext extends object, TServices, TResponse> = LocalCallTypeMap<
  TakibiMap<TContext, TServices>,
  TResponse,
  CollectionReadRequest
>;

/**
 * Contract `RuntimeAdapterMap` plus Takibi construction values (OTEL).
 */
export type TakibiRuntimeAdapterMap<
  TContext extends object = object,
  TServices = unknown,
> = RuntimeAdapterMap<{
  invocation: TakibiMap<TContext, TServices>;
  request: LocalCallType<TContext, TServices, WireResponse>["request"];
  decoded: LocalCallType<TContext, TServices, WireResponse>["decoded"];
  response: WireResponse;
  localExecution: LocalExecution<TContext, TServices>;
}> &
  Pick<
    TakibiAdapterMap<TContext, TServices>,
    "invocationPolicy" | "invocationSchema" | "invocationActionHandler" | "invocationPrepareApply"
  > & {
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

function createLocalExecution<TContext extends object, TServices>(deps: {
  invocationRun: BoundRunInvocation<TakibiMap<TContext, TServices>>;
  callSingle: TakibiCall<LocalCallInput<TContext>, WireResponse>;
  callBatch: TakibiCall<LocalCallInput<TContext>, WireResponse>;
}): LocalExecution<TContext, TServices> {
  return {
    run: (context, wireInvocation) => deps.invocationRun({ request: { wireInvocation, context } }),
    execute: (context, invocation) => deps.callSingle(localSingleCall(context, invocation)),
    executeBatch: (context, items) => deps.callBatch(localBatchCall(context, items)),
    executeHttp: async (context, invocation) =>
      jsonResponseFromStatus(await deps.callSingle(localSingleCall(context, invocation)), Response),
    executeBatchHttp: async (context, items) =>
      jsonResponseFromStatus(await deps.callBatch(localBatchCall(context, items)), Response),
  };
}

export async function resolveLocalAdapterMap<TContext extends object, TServices = unknown>(
  args: LocalInvocationExecutionArgs<TContext, TServices>,
  overrides?: Partial<TakibiRuntimeAdapterMap<TContext, TServices>>,
): Promise<TakibiRuntimeAdapterMap<TContext, TServices>> {
  type Map = TakibiRuntimeAdapterMap<TContext, TServices>;
  type Invocation = TakibiMap<TContext, TServices>;

  const graph = {
    ...RUNTIME_ADAPTER_GRAPH,
    ...TAKIBI_INVOCATION_REGISTRATION_GRAPH,
    localSpanKind: [],
    localParentSpan: [],
    localRequest: [],
    invocationRun: ["invocationCoreRun", "invocationRuntime", "localSpanKind", "localParentSpan"],
    callToSingleResponse: ["invocationRuntime", "localRequest"],
    callToBatchResponse: ["invocationRuntime", "localRequest"],
  } as const satisfies DependencyGraph<Map>;

  const builder = defineContainer<Map>()
    .graph(graph)
    .factories({
      ...createTakibiInvocationAdapterFactories<TContext, TServices>(),
      invocationCoreRun: inject(runInvocation<Invocation>),
      invocationRun: createInstrumentedInvocationRun,
      callDecode: () => decodeLocalCallRequest,
      callResolveContext: () => resolveLocalCallContext,
      callGetWireInvocation: () => getLocalCallWireInvocation,
      callGetWireInvocations: () => getLocalCallWireInvocations,
      callRuntimeChecks: () => undefined,
      callToSingleResponse: invocationToWireResponse,
      callToBatchResponse: invocationsToBatchWireResponse,
      callSingle: createSingleTakibiCall<
        LocalCallInput<TContext>,
        LocalCallInput<TContext>,
        Invocation,
        WireResponse
      >,
      callBatch: createBatchTakibiCall<
        LocalCallInput<TContext>,
        LocalCallInput<TContext>,
        Invocation,
        WireResponse
      >,
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
