import type {
  InvocationRequestData,
  ObserverInvocationData,
  TakibiFailure,
} from "@takibi/takibi-shared-types";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Collaborator bag for one invocation. Defined without input, result, or work
 * types so a runtime can be constructed and typed on its own.
 */
export type InvocationRuntime = Readonly<{
  collections: unknown;
  storage: unknown;
  registry: unknown;
  logger: unknown;
  services: unknown;
}>;

export type InternalInvocationTypeMap = {
  wireInvocation: InvocationRequestData;
  invocation: ObserverInvocationData;
  runtime: InvocationRuntime;
  context: object;
  rawInput: unknown;
  input: unknown;
  noneWork: unknown;
  applyWork: unknown;
  fullWork: unknown;
  nonePrepared: unknown;
  applyPrepared: unknown;
  fullPrepared: unknown;
  /** Execution values are carried unchanged; response adapters own serialization. */
  result: unknown;
  failure: TakibiFailure<string>;
};

/** One-way alias: the map names a runtime; the runtime does not name the map. */
export type InternalInvocationRuntime<T extends InternalInvocationTypeMap> = T["runtime"];

export type InternalInvocationPhase = "created" | "running" | "settled" | "notifying" | "notified";

export type InternalInvocationTransaction =
  | "none"
  | "open"
  | "committed"
  | "rolled-back"
  | "unknown";
export type InternalInvocationSettledTransaction = Exclude<InternalInvocationTransaction, "open">;

export type TransactionBoundary = "none" | "apply" | "full";

export type ExecutionPlan<TNoneWork, TApplyWork, TFullWork> =
  | Readonly<{
      transactionBoundary: "none";
      work: TNoneWork;
    }>
  | Readonly<{
      transactionBoundary: "apply";
      work: TApplyWork;
    }>
  | Readonly<{
      transactionBoundary: "full";
      work: TFullWork;
    }>;

export type ExecutePlanOptions<
  TStorage,
  TNoneWork,
  TApplyWork,
  TFullWork,
  TNonePrepared,
  TApplyPrepared,
  TFullPrepared,
  TResult,
> = {
  readonly plan: ExecutionPlan<TNoneWork, TApplyWork, TFullWork>;
  readonly storage: TStorage;
  readonly reuseTransaction?: boolean;
  readonly runInTransaction: <T>(work: (storage: TStorage) => MaybePromise<T>) => Promise<T>;
  readonly none: {
    prepare: (work: TNoneWork, storage: TStorage) => MaybePromise<TNonePrepared>;
    apply: (prepared: TNonePrepared, storage: TStorage) => MaybePromise<TResult>;
  };
  readonly apply: {
    prepare: (work: TApplyWork, storage: TStorage) => MaybePromise<TApplyPrepared>;
    apply: (prepared: TApplyPrepared, storage: TStorage) => MaybePromise<TResult>;
  };
  readonly full: {
    prepare: (work: TFullWork, storage: TStorage) => MaybePromise<TFullPrepared>;
    apply: (prepared: TFullPrepared, storage: TStorage) => MaybePromise<TResult>;
  };
};

export type InvocationPlan<T extends InternalInvocationTypeMap> = ExecutionPlan<
  T["noneWork"],
  T["applyWork"],
  T["fullWork"]
>;

export type InvocationInputState<TRawInput, TInput> =
  | Readonly<{ status: "not-applicable" }>
  | Readonly<{ status: "raw"; value: TRawInput }>
  | Readonly<{ status: "validated"; value: TInput }>
  | Readonly<{ status: "rejected" }>;

/**
 * Observer-visible input. Raw and rejected values stay off the event.
 * `validated` with an undefined value is distinct from `unavailable`.
 */
export type ObservedInput<TInput> =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "validated"; value: TInput }>;

export function toObservedInput<TRawInput, TInput>(
  input: InvocationInputState<TRawInput, TInput>,
): ObservedInput<TInput> {
  return input.status === "validated"
    ? { status: "validated", value: input.value }
    : { status: "unavailable" };
}

export type InternalInvocationFailureStage = "classify" | "execute" | "commit" | "rollback";

/**
 * Transaction failure facts supplied by an adapter. Failure stage identifies where the failure
 * occurred; transaction outcome records only what the adapter can confirm about rollback.
 */
export type InternalInvocationTransactionFailure = Readonly<{
  stage: InternalInvocationFailureStage;
  transaction: Extract<InternalInvocationSettledTransaction, "rolled-back" | "unknown">;
}>;

export type InternalInvocationFailure<TFailure> =
  | Readonly<{ kind: "mapped"; value: TFailure }>
  | Readonly<{ kind: "mapping-failed"; error: unknown; cause: unknown }>
  | Readonly<{ kind: "configuration"; error: unknown }>;

export type InternalInvocationSettlement<TResult, TFailure> =
  | Readonly<{ outcome: "succeeded"; result: TResult }>
  | Readonly<{
      outcome: "failed";
      stage: InternalInvocationFailureStage;
      failure: InternalInvocationFailure<TFailure>;
    }>;

export type InternalInvocationNotification =
  | Readonly<{ outcome: "succeeded" }>
  | Readonly<{ outcome: "failed"; error: unknown }>
  | Readonly<{ outcome: "skipped" }>;

export type InvocationCompletion<TInvocation, TResult, TFailure> =
  | (Extract<InternalInvocationSettlement<TResult, TFailure>, { outcome: "succeeded" }> &
      Readonly<{ invocation: TInvocation }>)
  | (Extract<InternalInvocationSettlement<TResult, TFailure>, { outcome: "failed" }> &
      Readonly<{ invocation: TInvocation | undefined }>);

export type InvocationObserverEvent<T extends InternalInvocationTypeMap> = Readonly<{
  phase: "settled";
  context: T["context"];
  input: ObservedInput<T["input"]>;
  transactionBoundary: TransactionBoundary | undefined;
  transaction: InternalInvocationSettledTransaction;
}> &
  InvocationCompletion<T["invocation"], T["result"], T["failure"]>;

export type TakibiCall<TRequestLike, TResponseObject> = (
  request: TRequestLike,
) => Promise<TResponseObject>;

/**
 * Minimal success/failure shape a runtime can project to HTTP. Extra fields
 * (body, error code) are allowed. Fetch `Response` is not required.
 */
export type StatusBearingResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: Readonly<{ status: number }> }>;

/** Factory that can build a JSON response with an optional status. */
export type JsonResponseLike<TResponse> = {
  json(body: unknown, init?: { readonly status?: number }): TResponse;
};

/** Small, shallow projection supplied to plan creation. */
export type InvocationPlanningView<T extends InternalInvocationTypeMap> = Readonly<{
  wireInvocation: T["wireInvocation"];
  invocation: T["invocation"];
  runtime: T["runtime"];
  context: T["context"];
  input: InvocationInputState<T["rawInput"], T["input"]>;
}>;

/**
 * Readonly terminal DTO returned by the public runner. Failures before wire
 * projection or plan creation represent unavailable values as `undefined`;
 * the private lifecycle sentinel never crosses this boundary.
 */
export type InvocationResult<T extends InternalInvocationTypeMap> = Readonly<{
  phase: "notified";
  wireInvocation: T["wireInvocation"];
  runtime: T["runtime"];
  context: T["context"];
  input: InvocationInputState<T["rawInput"], T["input"]>;
  effects: Readonly<{ transaction: InternalInvocationSettledTransaction }>;
  notification: InternalInvocationNotification;
}> &
  (
    | Readonly<{
        invocation: T["invocation"];
        plan: InvocationPlan<T>;
        settlement: Readonly<{ outcome: "succeeded"; result: T["result"] }>;
      }>
    | Readonly<{
        invocation: T["invocation"] | undefined;
        plan: InvocationPlan<T> | undefined;
        settlement: Readonly<{
          outcome: "failed";
          stage: InternalInvocationFailureStage;
          failure: InternalInvocationFailure<T["failure"]>;
        }>;
      }>
  );

export type InvocationExecutionView<T extends InternalInvocationTypeMap> = Readonly<{
  context: T["context"];
  invocation: T["invocation"];
  plan: InvocationPlan<T>;
  input: InvocationInputState<T["rawInput"], T["input"]>;
  runtime: Pick<T["runtime"], "collections" | "logger" | "services">;
}>;

/** Undefined fields leave the current state unchanged; validated input may itself hold undefined. */
export type InvocationUpdates<T extends InternalInvocationTypeMap> = Readonly<{
  context?: T["context"];
  input?: InvocationInputState<T["rawInput"], T["input"]>;
}>;

/**
 * Adapter failures are values so updates completed before a later throw remain
 * visible to failure settlement and notification.
 */
export type InvocationAdapterResult<T extends InternalInvocationTypeMap, TValue> =
  | Readonly<{ outcome: "succeeded"; value: TValue; updates?: InvocationUpdates<T> }>
  | Readonly<{ outcome: "failed"; error: unknown; updates?: InvocationUpdates<T> }>;

export type PrepareApplyInvocationContract<
  T extends InternalInvocationTypeMap,
  TWork,
  TPrepared,
> = {
  prepare(
    state: InvocationExecutionView<T>,
    work: TWork,
    storage: T["runtime"]["storage"],
  ): MaybePromise<InvocationAdapterResult<T, TPrepared>>;
  apply(
    state: InvocationExecutionView<T>,
    prepared: TPrepared,
    storage: T["runtime"]["storage"],
  ): MaybePromise<InvocationAdapterResult<T, T["result"]>>;
};

export type FullInvocationContract<
  T extends InternalInvocationTypeMap,
  TWork,
  TPrepared,
> = PrepareApplyInvocationContract<T, TWork, TPrepared>;

export type InvocationTransactionBoundaryContracts<T extends InternalInvocationTypeMap> = {
  none: PrepareApplyInvocationContract<T, T["noneWork"], T["nonePrepared"]>;
  apply: PrepareApplyInvocationContract<T, T["applyWork"], T["applyPrepared"]>;
  full: PrepareApplyInvocationContract<T, T["fullWork"], T["fullPrepared"]>;
};

/** Public runner request. Mutable lifecycle state is allocated inside the runner. */
export type InvocationRequest<T extends InternalInvocationTypeMap> = {
  readonly wireInvocation: T["wireInvocation"];
  readonly context: T["context"];
};

/** Request-specific values accepted by an adapter-injected invocation runner. */
export type InvocationRunOptions<T extends InternalInvocationTypeMap> = {
  readonly request: InvocationRequest<T>;
  readonly invocationRuntimeChecks?: boolean;
};

/**
 * An invocation runner with stable runtime adapters already injected.
 * Request-specific state remains an invocation-time argument.
 */
export type BoundRunInvocation<T extends InternalInvocationTypeMap> = (
  options: InvocationRunOptions<T>,
) => Promise<InvocationResult<T>>;

/**
 * Complete runtime composition contract for invocation execution.
 * Composition libraries are deliberately absent from this public type.
 */
type InvocationAdapterMap<T extends InternalInvocationTypeMap> = {
  invocationRuntime: T["runtime"];
  invocationToInvocation: (wireInvocation: T["wireInvocation"]) => T["invocation"];
  invocationGetRawInput: (wireInvocation: T["wireInvocation"]) => T["rawInput"];
  invocationCreatePlan: (
    view: InvocationPlanningView<T>,
  ) => MaybePromise<InvocationAdapterResult<T, InvocationPlan<T>>>;
  /**
   * Runtime-pinned collaborators consumed by `invocationPrepareApply`.
   * Concrete policy / schema / handler types stay in the runtime.
   */
  invocationPolicy: unknown;
  invocationSchema: unknown;
  invocationActionHandler: unknown;
  invocationPrepareApply: PrepareApplyInvocationContract<
    T,
    T["noneWork"] | T["applyWork"] | T["fullWork"],
    T["nonePrepared"] | T["applyPrepared"] | T["fullPrepared"]
  >;
  invocationTransactionBoundary: InvocationTransactionBoundaryContracts<T>;
  transactionNone: InvocationTransactionBoundaryContracts<T>["none"];
  transactionApply: InvocationTransactionBoundaryContracts<T>["apply"];
  transactionFull: InvocationTransactionBoundaryContracts<T>["full"];
  transactionRun:
    | (<TResult>(work: (storage: T["runtime"]["storage"]) => Promise<TResult>) => Promise<TResult>)
    | undefined;
  transactionClassifyFailure:
    | ((input: { error: unknown; workCompleted: boolean }) => InternalInvocationTransactionFailure)
    | undefined;
  invocationToFailure: (error: unknown) => T["failure"];
  /**
   * Produces an observer-owned value graph. Generic contract values are opaque and therefore
   * cannot be assumed to support JSON or structured cloning.
   */
  invocationSnapshotObserverEvent: (
    event: InvocationObserverEvent<T>,
  ) => MaybePromise<InvocationObserverEvent<T>>;
  invocationNotify: ((event: InvocationObserverEvent<T>) => MaybePromise<void>) | undefined;
  invocationRun: BoundRunInvocation<T>;
};

export type CallTypeMap<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = {
  request: TRequestLike;
  decoded: TDecoded;
  context: TInvocation["context"];
  invocation: TInvocation;
  response: TResponseObject;
};

/**
 * Already-decoded in-process Call envelope. `items` may be a narrower wire
 * than `invocation` when a runtime only batches a subset of operations.
 */
export type LocalCallRequest<TContext, TWireInvocation, TBatchItem = TWireInvocation> =
  | Readonly<{
      kind: "single";
      context: TContext;
      invocation: TWireInvocation;
    }>
  | Readonly<{
      kind: "batch";
      context: TContext;
      items: readonly TBatchItem[];
    }>;

export type LocalCallTypeMap<
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
  TBatchItem = TInvocation["wireInvocation"],
> = CallTypeMap<
  LocalCallRequest<TInvocation["context"], TInvocation["wireInvocation"], TBatchItem>,
  LocalCallRequest<TInvocation["context"], TInvocation["wireInvocation"], TBatchItem>,
  TInvocation,
  TResponseObject
>;

type CallAdapterSlots<T extends CallTypeMap<unknown, unknown, InternalInvocationTypeMap, unknown>> =
  {
    callDecode: (request: T["request"]) => MaybePromise<T["decoded"]>;
    callResolveContext: (input: {
      request: T["request"];
      decoded: T["decoded"];
    }) => MaybePromise<T["context"]>;
    callGetWireInvocation: (input: {
      request: T["request"];
      decoded: T["decoded"];
      context: T["context"];
    }) => MaybePromise<T["invocation"]["wireInvocation"]>;
    callGetWireInvocations: (input: {
      request: T["request"];
      decoded: T["decoded"];
      context: T["context"];
    }) => MaybePromise<readonly T["invocation"]["wireInvocation"][]>;
    callToSingleResponse: (input: {
      request: T["request"];
      decoded: T["decoded"];
      context: T["context"];
      invocation: InvocationResult<T["invocation"]>;
    }) => MaybePromise<T["response"]>;
    callToBatchResponse: (input: {
      request: T["request"];
      decoded: T["decoded"];
      context: T["context"];
      invocations: readonly InvocationResult<T["invocation"]>[];
    }) => MaybePromise<T["response"]>;
    callRuntimeChecks: boolean | (() => boolean) | undefined;
    callSingle: TakibiCall<T["request"], T["response"]>;
    callBatch: TakibiCall<T["request"], T["response"]>;
  };

export type AdapterMap<T extends InternalInvocationTypeMap> = InvocationAdapterMap<T>;

export type CallAdapterMap<
  T extends InternalInvocationTypeMap,
  TCall extends CallTypeMap<unknown, unknown, T, unknown>,
> = AdapterMap<T> & CallAdapterSlots<TCall>;

/**
 * Local DO / in-process composition surface. `invocationRun` is the runner
 * Calls consume. `invocationCoreRun` is the injected `runInvocation` before a
 * runtime applies instrumentation. Call slots stay on `CallAdapterMap`;
 * `localExecution` is the runtime facade over `callSingle` / `callBatch`.
 */
export type RuntimeAdapterMap<
  T extends InternalInvocationTypeMap,
  TCall extends CallTypeMap<unknown, unknown, T, unknown>,
  TLocalExecution,
> = CallAdapterMap<T, TCall> & {
  invocationCoreRun: BoundRunInvocation<T>;
  localExecution: TLocalExecution;
};

export const CALL_SINGLE_ADAPTER_KEYS = [
  "invocationRun",
  "callDecode",
  "callResolveContext",
  "callGetWireInvocation",
  "callRuntimeChecks",
  "callToSingleResponse",
] as const;

export const CALL_BATCH_ADAPTER_KEYS = [
  "invocationRun",
  "callDecode",
  "callResolveContext",
  "callGetWireInvocations",
  "callRuntimeChecks",
  "callToBatchResponse",
] as const;

export const INVOCATION_PREPARE_ADAPTER_KEYS = [
  "invocationPolicy",
  "invocationSchema",
  "invocationActionHandler",
] as const;

export const ENVELOPE_CALL_ADAPTER_KEYS = [
  "callDecode",
  "callResolveContext",
  "callDispatch",
  "callToResponse",
  "callToFailureResponse",
  "callOnDecoded",
  "callOnTerminal",
] as const;

/**
 * The statically declared subset an adapter factory is allowed to read.
 */
export type Adapters<
  T extends InternalInvocationTypeMap,
  K extends keyof CallAdapterMap<T, TCall>,
  TCall extends CallTypeMap<unknown, unknown, T, unknown> = CallTypeMap<
    unknown,
    unknown,
    T,
    unknown
  >,
> = Pick<CallAdapterMap<T, TCall>, K>;

export const INVOCATION_ADAPTER_KEYS = [
  "invocationRuntime",
  "invocationToInvocation",
  "invocationGetRawInput",
  "invocationCreatePlan",
  "transactionNone",
  "transactionApply",
  "transactionFull",
  "transactionRun",
  "transactionClassifyFailure",
  "invocationToFailure",
  "invocationSnapshotObserverEvent",
  "invocationNotify",
] as const;

export type InvocationAdapterKeys = (typeof INVOCATION_ADAPTER_KEYS)[number];

/**
 * Stable adapters read directly by the invocation runner. The names are the
 * canonical AdapterMap slots; no second execution-shaped adapter bag exists.
 */
export type InvocationAdapters<T extends InternalInvocationTypeMap> = Adapters<
  T,
  InvocationAdapterKeys
>;

export type CallFailureStage = "decode" | "resolve" | "dispatch" | "response";

export type CallFailureInput<TRequestLike, TDecoded, TContext> = Readonly<{
  stage: CallFailureStage;
  error: unknown;
  request: TRequestLike;
  decoded?: TDecoded;
  context?: TContext;
}>;

export type CallTerminalEvent<TResponseObject, TRequestLike = unknown, TDecoded = unknown> =
  | Readonly<{
      outcome: "responded";
      request: TRequestLike;
      decoded?: TDecoded;
      response: TResponseObject;
    }>
  | Readonly<{
      outcome: "rejected";
      request: TRequestLike;
      decoded?: TDecoded;
      error: unknown;
    }>;

/**
 * Envelope Call constructor slots. Names match `ENVELOPE_CALL_ADAPTER_KEYS`
 * so `inject(Call)` can read the same graph the runtime registers.
 */
export type CallAdapters<
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
> = {
  callDecode: (request: TRequestLike) => MaybePromise<TDecoded>;
  callResolveContext: (input: {
    request: TRequestLike;
    decoded: TDecoded;
  }) => MaybePromise<TContext>;
  callDispatch: (input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
  }) => MaybePromise<TDispatched>;
  callToResponse: (input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
    dispatched: TDispatched;
  }) => MaybePromise<TResponseObject>;
  callToFailureResponse?: (
    failure: CallFailureInput<TRequestLike, TDecoded, TContext>,
  ) => MaybePromise<TResponseObject>;
  callOnDecoded?: (input: { request: TRequestLike; decoded: TDecoded }) => MaybePromise<void>;
  callOnTerminal?: (
    event: CallTerminalEvent<TResponseObject, TRequestLike, TDecoded>,
  ) => MaybePromise<void>;
};

/**
 * Worker / testing envelope composition surface. `call` is the constructed
 * `Call` instance. This map does not include invocation or storage slots.
 */
export type EnvelopeAdapterMap<
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
  TCall = unknown,
> = CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched> & {
  call: TCall;
};

export type SingleCallAdapters<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = Adapters<
  TInvocation,
  | "callDecode"
  | "callResolveContext"
  | "callGetWireInvocation"
  | "callToSingleResponse"
  | "callRuntimeChecks"
  | "invocationRun",
  CallTypeMap<TRequestLike, TDecoded, TInvocation, TResponseObject>
>;

export type BatchCallAdapters<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = Adapters<
  TInvocation,
  | "callDecode"
  | "callResolveContext"
  | "callGetWireInvocations"
  | "callToBatchResponse"
  | "callRuntimeChecks"
  | "invocationRun",
  CallTypeMap<TRequestLike, TDecoded, TInvocation, TResponseObject>
>;

export type SingleTakibiCallOptions<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = SingleCallAdapters<TRequestLike, TDecoded, TInvocation, TResponseObject>;

export type BatchTakibiCallOptions<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = BatchCallAdapters<TRequestLike, TDecoded, TInvocation, TResponseObject>;

export type CreateSingleTakibiCall = <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  options: SingleTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
) => TakibiCall<TRequestLike, TResponseObject>;

export type CreateBatchTakibiCall = <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  options: BatchTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
) => TakibiCall<TRequestLike, TResponseObject>;

export type RunSingleCall = <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  options: SingleTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
  request: TRequestLike,
) => Promise<TResponseObject>;

export type RunBatchCall = <
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
>(
  options: BatchTakibiCallOptions<TRequestLike, TDecoded, TInvocation, TResponseObject>,
  request: TRequestLike,
) => Promise<TResponseObject>;

export type RunCall = <
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
>(
  request: TRequestLike,
  adapters: CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched>,
) => Promise<TResponseObject>;

export type RunInvocation = <T extends InternalInvocationTypeMap>(
  adapters: InvocationAdapters<T>,
  options: InvocationRunOptions<T>,
) => Promise<InvocationResult<T>>;

export type ResolveRuntimeChecks = (value: boolean | (() => boolean) | undefined) => boolean;
