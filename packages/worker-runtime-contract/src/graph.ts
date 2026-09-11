import {
  CALL_BATCH_ADAPTER_KEYS,
  CALL_SINGLE_ADAPTER_KEYS,
  ENVELOPE_CALL_ADAPTER_KEYS,
  INVOCATION_ADAPTER_KEYS,
  INVOCATION_PREPARE_ADAPTER_KEYS,
  type RuntimeAdapterMap,
} from "./type";

type RuntimeAdapterMapKeys = keyof RuntimeAdapterMap;

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
  invocationPolicy: [],
  invocationSchema: [],
  invocationActionHandler: [],
  invocationPrepareApply: INVOCATION_PREPARE_ADAPTER_KEYS,
  transactionNone: ["invocationPrepareApply"],
  transactionApply: ["invocationPrepareApply"],
  transactionFull: ["invocationPrepareApply"],
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

export type EnvelopeAdapterGraph = {
  readonly [K in (typeof ENVELOPE_CALL_ADAPTER_KEYS)[number] | "call"]: readonly (
    | (typeof ENVELOPE_CALL_ADAPTER_KEYS)[number]
    | "call"
  )[];
};

/**
 * Worker / testing envelope Call. `call` is the `Call` class node. This graph
 * does not read invocation or storage adapters; production dispatch forwards
 * the whole envelope.
 */
export const ENVELOPE_ADAPTER_GRAPH = {
  callDecode: [],
  callResolveContext: [],
  callDispatch: [],
  callToResponse: [],
  callToFailureResponse: [],
  callOnDecoded: [],
  callOnTerminal: [],
  call: ENVELOPE_CALL_ADAPTER_KEYS,
} as const satisfies EnvelopeAdapterGraph;
