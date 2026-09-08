import { runCall } from "./request";
import type {
  BatchTakibiCallOptions,
  CreateBatchTakibiCall,
  CreateSingleTakibiCall,
  InternalInvocationTypeMap,
  MaybePromise,
  ResolveRuntimeChecks,
  RunBatchCall,
  RunSingleCall,
  SingleTakibiCallOptions,
  TakibiCall,
} from "./type";

export const createSingleTakibiCall: CreateSingleTakibiCall = function <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  options: SingleTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
): TakibiCall<TRequestLike, TResponseObject> {
  return (request) => runSingleCall(options, request);
};

export const createBatchTakibiCall: CreateBatchTakibiCall = function <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  options: BatchTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
): TakibiCall<TRequestLike, TResponseObject> {
  return (request) => runBatchCall(options, request);
};

export const runSingleCall: RunSingleCall = async function <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  adapters: SingleTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
  request: TRequestLike,
): Promise<TResponseObject> {
  const invocationRuntimeChecks = resolveRuntimeChecks(adapters.callRuntimeChecks);
  return runResolvedRequest(adapters, request, async (resolved) => {
    const wireInvocation = await adapters.callGetWireInvocation(resolved);
    const invocation = await adapters.invocationRun({
      request: { wireInvocation, context: resolved.context },
      invocationRuntimeChecks,
    });
    return adapters.callToSingleResponse({ ...resolved, invocation });
  });
};

export const runBatchCall: RunBatchCall = async function <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  adapters: BatchTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
  request: TRequestLike,
): Promise<TResponseObject> {
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
};

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
    decode: adapters.callDecode,
    resolveContext: adapters.callResolveContext,
    dispatch,
  });

const resolveRuntimeChecks: ResolveRuntimeChecks = function (
  value: boolean | (() => boolean) | undefined,
): boolean {
  return typeof value === "function" ? value() : (value ?? true);
};
