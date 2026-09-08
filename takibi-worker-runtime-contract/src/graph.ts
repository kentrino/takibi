import {
  CALL_BATCH_ADAPTER_KEYS,
  CALL_SINGLE_ADAPTER_KEYS,
  INVOCATION_ADAPTER_KEYS,
  type CallTypeMap,
  type InternalInvocationTypeMap,
  type RuntimeAdapterMap,
} from "./type";

type RuntimeAdapterMapKeys = keyof RuntimeAdapterMap<
  InternalInvocationTypeMap,
  CallTypeMap<unknown, unknown, InternalInvocationTypeMap, unknown>,
  unknown
>;

export type RuntimeAdapterGraph = {
  readonly [K in RuntimeAdapterMapKeys]: readonly RuntimeAdapterMapKeys[];
};

/**
 * Edges for `RuntimeAdapterMap`. A runtime may add construction-only slots
 * (instrumentation, request) and override edges that need those slots.
 * The contract does not depend on a container library.
 */
export const RUNTIME_ADAPTER_GRAPH = {
  invocationRuntime: [],
  invocationToInvocation: [],
  invocationGetRawInput: [],
  invocationCreatePlan: [],
  invocationTransactionBoundary: ["invocationRuntime"],
  transactionNone: ["invocationTransactionBoundary"],
  transactionApply: ["invocationTransactionBoundary"],
  transactionFull: ["invocationTransactionBoundary"],
  transactionRun: ["invocationRuntime"],
  transactionClassifyFailure: [],
  invocationToFailure: [],
  invocationSnapshotObserverEvent: [],
  invocationNotify: [],
  invocationCoreRun: INVOCATION_ADAPTER_KEYS,
  invocationRun: ["invocationCoreRun"],
  callDecode: [],
  callResolveContext: [],
  callGetWireInvocation: [],
  callGetWireInvocations: [],
  callRuntimeChecks: [],
  callToSingleResponse: ["invocationRuntime"],
  callToBatchResponse: ["invocationRuntime"],
  callSingle: CALL_SINGLE_ADAPTER_KEYS,
  callBatch: CALL_BATCH_ADAPTER_KEYS,
  localExecution: ["invocationRun", "callSingle", "callBatch"],
} as const satisfies RuntimeAdapterGraph;
