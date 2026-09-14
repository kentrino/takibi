import type {
  BoundRunInvocation,
  InternalInvocationTypeMap,
  InvocationResult,
  MaybePromise,
} from "@takibi/invocation-lifecycle";
import { runCall } from "./call";

type ResolvedCallInput<TRequest, TDecoded, TInvocation extends InternalInvocationTypeMap> = {
  request: TRequest;
  decoded: TDecoded;
  context: TInvocation["context"];
};

export type SingleCallAdapters<
  TRequest,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponse,
> = {
  invocationRun: BoundRunInvocation<TInvocation>;
  callDecode: (request: TRequest) => MaybePromise<TDecoded>;
  callResolveContext: (input: {
    request: TRequest;
    decoded: TDecoded;
  }) => MaybePromise<TInvocation["context"]>;
  callGetWireInvocation: (
    input: ResolvedCallInput<TRequest, TDecoded, TInvocation>,
  ) => MaybePromise<TInvocation["wireInvocation"]>;
  callRuntimeChecks: boolean | (() => boolean) | undefined;
  callToSingleResponse: (
    input: ResolvedCallInput<TRequest, TDecoded, TInvocation> & {
      invocation: InvocationResult<TInvocation>;
    },
  ) => MaybePromise<TResponse>;
};

export type BatchCallAdapters<
  TRequest,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponse,
> = {
  invocationRun: BoundRunInvocation<TInvocation>;
  callDecode: (request: TRequest) => MaybePromise<TDecoded>;
  callResolveContext: (input: {
    request: TRequest;
    decoded: TDecoded;
  }) => MaybePromise<TInvocation["context"]>;
  callGetWireInvocations: (
    input: ResolvedCallInput<TRequest, TDecoded, TInvocation>,
  ) => MaybePromise<readonly TInvocation["wireInvocation"][]>;
  callRuntimeChecks: boolean | (() => boolean) | undefined;
  callToBatchResponse: (
    input: ResolvedCallInput<TRequest, TDecoded, TInvocation> & {
      invocations: readonly InvocationResult<TInvocation>[];
    },
  ) => MaybePromise<TResponse>;
};

export type TakibiCall<TRequest, TResponse> = (request: TRequest) => Promise<TResponse>;

export function createSingleTakibiCall<
  TRequest,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponse,
>(
  options: SingleCallAdapters<TRequest, TDecoded, TInvocation, TResponse>,
): TakibiCall<TRequest, TResponse> {
  return (request) => runSingleCall(options, request);
}

export function createBatchTakibiCall<
  TRequest,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponse,
>(
  options: BatchCallAdapters<TRequest, TDecoded, TInvocation, TResponse>,
): TakibiCall<TRequest, TResponse> {
  return (request) => runBatchCall(options, request);
}

export async function runSingleCall<
  TRequest,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponse,
>(
  adapters: SingleCallAdapters<TRequest, TDecoded, TInvocation, TResponse>,
  request: TRequest,
): Promise<TResponse> {
  const invocationRuntimeChecks = resolveRuntimeChecks(adapters.callRuntimeChecks);
  return runResolvedRequest(adapters, request, async (resolved) => {
    const wireInvocation = await adapters.callGetWireInvocation(resolved);
    const invocation = await adapters.invocationRun({
      request: { wireInvocation, context: resolved.context },
      invocationRuntimeChecks,
    });
    return adapters.callToSingleResponse({ ...resolved, invocation });
  });
}

export async function runBatchCall<
  TRequest,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponse,
>(
  adapters: BatchCallAdapters<TRequest, TDecoded, TInvocation, TResponse>,
  request: TRequest,
): Promise<TResponse> {
  const invocationRuntimeChecks = resolveRuntimeChecks(adapters.callRuntimeChecks);
  return runResolvedRequest(adapters, request, async (resolved) => {
    const wireInvocations = await adapters.callGetWireInvocations(resolved);
    const invocations = [];
    for (const wireInvocation of wireInvocations) {
      invocations.push(
        await adapters.invocationRun({
          request: { wireInvocation, context: resolved.context },
          invocationRuntimeChecks,
        }),
      );
    }
    return adapters.callToBatchResponse({ ...resolved, invocations });
  });
}

const runResolvedRequest = async <TRequestLike, TDecoded, TContext, TResponseObject>(
  adapters: {
    callDecode: (request: TRequestLike) => MaybePromise<TDecoded>;
    callResolveContext: (input: {
      request: TRequestLike;
      decoded: TDecoded;
    }) => MaybePromise<TContext>;
  },
  request: TRequestLike,
  dispatch: (input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
  }) => MaybePromise<TResponseObject>,
): Promise<TResponseObject> =>
  runCall(request, {
    callDecode: adapters.callDecode,
    callResolveContext: adapters.callResolveContext,
    callDispatch: dispatch,
    callToResponse: ({ dispatched }) => dispatched,
  });

const resolveRuntimeChecks = function (value: boolean | (() => boolean) | undefined): boolean {
  return typeof value === "function" ? value() : (value ?? true);
};
