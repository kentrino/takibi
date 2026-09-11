import { runCall } from "./request";
import type {
  CreateBatchTakibiCall,
  CreateSingleTakibiCall,
  MaybePromise,
  ResolveRuntimeChecks,
  RunBatchCall,
  RunSingleCall,
} from "./type";

export const createSingleTakibiCall: CreateSingleTakibiCall = (options) => {
  return (request) => runSingleCall(options, request);
};

export const createBatchTakibiCall: CreateBatchTakibiCall = (options) => {
  return (request) => runBatchCall(options, request);
};

export const runSingleCall: RunSingleCall = async (adapters, request) => {
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

export const runBatchCall: RunBatchCall = async (adapters, request) => {
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
    callDecode: adapters.callDecode,
    callResolveContext: adapters.callResolveContext,
    callDispatch: dispatch,
    callToResponse: ({ dispatched }) => dispatched,
  });

const resolveRuntimeChecks: ResolveRuntimeChecks = function (
  value: boolean | (() => boolean) | undefined,
): boolean {
  return typeof value === "function" ? value() : (value ?? true);
};
