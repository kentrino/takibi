export type MaybePromise<T> = T | Promise<T>;

export type InternalInvocationTypeMap = {
  wireInvocation: unknown;
  invocation: unknown;
  collections: unknown;
  storage: unknown;
  registry: unknown;
  context: unknown;
  logger: unknown;
  services: unknown;
  rawInput: unknown;
  input: unknown;
  noneWork: unknown;
  applyWork: unknown;
  fullWork: unknown;
  nonePrepared: unknown;
  applyPrepared: unknown;
  result: unknown;
  failure: unknown;
};

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
    prepareAndApply: (work: TFullWork, storage: TStorage) => MaybePromise<TResult>;
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

export type InternalInvocationRuntime<T extends InternalInvocationTypeMap> = Readonly<{
  readonly collections: T["collections"];
  readonly storage: T["storage"];
  readonly registry: T["registry"];
  readonly logger: T["logger"];
  readonly services: T["services"];
}>;

export type InvocationObserverEvent<T extends InternalInvocationTypeMap> = Readonly<{
  phase: "settled";
  context: T["context"];
  services: T["services"];
  inputAvailable: boolean;
  input: T["input"] | undefined;
  transactionBoundary: TransactionBoundary | undefined;
  transaction: InternalInvocationSettledTransaction;
}> &
  (
    | Readonly<{
        outcome: "succeeded";
        invocation: T["invocation"];
        result: T["result"];
      }>
    | Readonly<{
        outcome: "failed";
        invocation: T["invocation"] | undefined;
        stage: InternalInvocationFailureStage;
        failure: InternalInvocationFailure<T["failure"]>;
      }>
  );

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
  runtime: InternalInvocationRuntime<T>;
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
  runtime: InternalInvocationRuntime<T>;
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
  runtime: Pick<InternalInvocationRuntime<T>, "collections" | "logger" | "services">;
}>;

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
    storage: T["storage"],
  ): MaybePromise<InvocationAdapterResult<T, TPrepared>>;
  apply(
    state: InvocationExecutionView<T>,
    prepared: TPrepared,
    storage: T["storage"],
  ): MaybePromise<InvocationAdapterResult<T, T["result"]>>;
};

export type FullInvocationContract<T extends InternalInvocationTypeMap, TWork> = {
  prepareAndApply(
    state: InvocationExecutionView<T>,
    work: TWork,
    storage: T["storage"],
  ): MaybePromise<InvocationAdapterResult<T, T["result"]>>;
};

export type InvocationTransactionBoundaryContracts<T extends InternalInvocationTypeMap> = {
  none: PrepareApplyInvocationContract<T, T["noneWork"], T["nonePrepared"]>;
  apply: PrepareApplyInvocationContract<T, T["applyWork"], T["applyPrepared"]>;
  full: FullInvocationContract<T, T["fullWork"]>;
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
  invocationRuntime: InternalInvocationRuntime<T>;
  invocationToInvocation: (wireInvocation: T["wireInvocation"]) => T["invocation"];
  invocationGetRawInput: (wireInvocation: T["wireInvocation"]) => T["rawInput"];
  invocationCreatePlan: (
    view: InvocationPlanningView<T>,
  ) => MaybePromise<InvocationAdapterResult<T, InvocationPlan<T>>>;
  invocationTransactionBoundary: InvocationTransactionBoundaryContracts<T>;
  transactionNone: InvocationTransactionBoundaryContracts<T>["none"];
  transactionApply: InvocationTransactionBoundaryContracts<T>["apply"];
  transactionFull: InvocationTransactionBoundaryContracts<T>["full"];
  transactionRun:
    | (<TResult>(work: (storage: T["storage"]) => Promise<TResult>) => Promise<TResult>)
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

/**
 * Call-level lifecycle adapters shared by single and batch calls.
 */
export type CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject> = {
  decode: (request: TRequestLike) => MaybePromise<TDecoded>;
  resolveContext: (input: { request: TRequestLike; decoded: TDecoded }) => MaybePromise<TContext>;
  dispatch: (input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
  }) => MaybePromise<TResponseObject>;
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

export type RunCall = <TRequestLike, TDecoded, TContext, TResponseObject>(
  request: TRequestLike,
  adapters: CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject>,
) => Promise<TResponseObject>;

export type RunInvocation = <T extends InternalInvocationTypeMap>(
  adapters: InvocationAdapters<T>,
  options: InvocationRunOptions<T>,
) => Promise<InvocationResult<T>>;

export type ResolveRuntimeChecks = (value: boolean | (() => boolean) | undefined) => boolean;
