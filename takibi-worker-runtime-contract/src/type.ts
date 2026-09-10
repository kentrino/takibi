import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ActionGateContext,
  CollectionDefinition,
  RuntimeActionDefinition,
} from "@takibi/takibi-api";
import type { InternalLogger } from "@takibi/takibi-logger";
import type { AccessContext, AccessGrant } from "@takibi/takibi-policy";
import type {
  ActionRequestData,
  InvocationRequestData,
  JsonValue,
  ObserverInvocationData,
  TakibiFailure,
} from "@takibi/takibi-shared-types";

export type { InternalLogger, LogEvent, LogLevel } from "@takibi/takibi-logger";

export type MaybePromise<T> = T | Promise<T>;

export type PolicySurface = {
  evaluateCollection: (
    def: CollectionDefinition,
    accessCtx: AccessContext<any, any>,
    options: { conceal: boolean; id?: string },
  ) => Promise<AccessGrant>;
  evaluateAction: (
    definition: RuntimeActionDefinition,
    actionCtx: object,
    invocation: ActionRequestData,
    gateContext: ActionGateContext<object>,
    doc?: unknown,
  ) => Promise<AccessGrant>;
};

export type SchemaSurface = {
  parse: <S extends StandardSchemaV1>(
    schema: S,
    value: unknown,
  ) => Promise<StandardSchemaV1.InferOutput<S>>;
};

/** Common runtime arguments; schema-specific input and services remain opaque here. */
export type ActionHandlerArgs = {
  ctx: object;
  collections: object;
  $collections: object;
  services: unknown;
  input: unknown;
  collection?: object;
  $collection?: object;
  id?: string;
  doc?: unknown;
};

export type ActionHandlerSurface = {
  run: (args: ActionHandlerArgs) => Promise<JsonValue>;
};

export type ActionHandlerCtor = {
  readonly definition: RuntimeActionDefinition;
  readonly logger?: InternalLogger;
  readonly collection?: string;
  readonly operation?: string;
  readonly documentId?: string;
  readonly actionName?: string;
  readonly actionScope?: string;
};

/**
 * Collaborator bag for one invocation. Defined without input, result, or work
 * types so a runtime can be constructed and typed on its own.
 */
export type InvocationRuntime = Readonly<{
  collections: unknown;
  storage: unknown;
  registry: unknown;
  logger: InternalLogger | undefined;
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

/** Runtime type choices; invocation context has a single source of truth. */
export type RuntimeTypeMap<
  TInvocation extends InternalInvocationTypeMap = InternalInvocationTypeMap,
> = {
  invocation: TInvocation;
  request: unknown;
  decoded: unknown;
  response: unknown;
  localExecution: unknown;
};

/** All local runtime DI slots. Consumer adapter sets are projections of this map. */
export type RuntimeAdapterMap<T extends RuntimeTypeMap = RuntimeTypeMap> = {
  invocationRuntime: T["invocation"]["runtime"];
  invocationToInvocation: (
    wireInvocation: T["invocation"]["wireInvocation"],
  ) => T["invocation"]["invocation"];
  invocationGetRawInput: (
    wireInvocation: T["invocation"]["wireInvocation"],
  ) => T["invocation"]["rawInput"];
  invocationCreatePlan: (
    view: InvocationPlanningView<T["invocation"]>,
  ) => MaybePromise<InvocationAdapterResult<T["invocation"], InvocationPlan<T["invocation"]>>>;
  /**
   * Runtime-pinned collaborators consumed by `invocationPrepareApply`.
   * Implementations and tracing stay in the runtime.
   */
  invocationPolicy: PolicySurface;
  invocationSchema: SchemaSurface;
  invocationActionHandler: (ctor: ActionHandlerCtor) => ActionHandlerSurface;
  invocationPrepareApply: PrepareApplyInvocationContract<
    T["invocation"],
    T["invocation"]["noneWork"] | T["invocation"]["applyWork"] | T["invocation"]["fullWork"],
    | T["invocation"]["nonePrepared"]
    | T["invocation"]["applyPrepared"]
    | T["invocation"]["fullPrepared"]
  >;
  transactionNone: InvocationTransactionBoundaryContracts<T["invocation"]>["none"];
  transactionApply: InvocationTransactionBoundaryContracts<T["invocation"]>["apply"];
  transactionFull: InvocationTransactionBoundaryContracts<T["invocation"]>["full"];
  transactionRun:
    | (<TResult>(
        work: (storage: T["invocation"]["runtime"]["storage"]) => Promise<TResult>,
      ) => Promise<TResult>)
    | undefined;
  transactionClassifyFailure:
    | ((input: { error: unknown; workCompleted: boolean }) => InternalInvocationTransactionFailure)
    | undefined;
  invocationToFailure: (error: unknown) => T["invocation"]["failure"];
  /**
   * Produces an observer-owned value graph. Generic contract values are opaque and therefore
   * cannot be assumed to support JSON or structured cloning.
   */
  invocationSnapshotObserverEvent: (
    event: InvocationObserverEvent<T["invocation"]>,
  ) => MaybePromise<InvocationObserverEvent<T["invocation"]>>;
  invocationNotify:
    | ((event: InvocationObserverEvent<T["invocation"]>) => MaybePromise<void>)
    | undefined;
  invocationRun: BoundRunInvocation<T["invocation"]>;

  callDecode: (request: T["request"]) => MaybePromise<T["decoded"]>;
  callResolveContext: (input: {
    request: T["request"];
    decoded: T["decoded"];
  }) => MaybePromise<T["invocation"]["context"]>;
  callGetWireInvocation: (input: {
    request: T["request"];
    decoded: T["decoded"];
    context: T["invocation"]["context"];
  }) => MaybePromise<T["invocation"]["wireInvocation"]>;
  callGetWireInvocations: (input: {
    request: T["request"];
    decoded: T["decoded"];
    context: T["invocation"]["context"];
  }) => MaybePromise<readonly T["invocation"]["wireInvocation"][]>;
  callToSingleResponse: (input: {
    request: T["request"];
    decoded: T["decoded"];
    context: T["invocation"]["context"];
    invocation: InvocationResult<T["invocation"]>;
  }) => MaybePromise<T["response"]>;
  callToBatchResponse: (input: {
    request: T["request"];
    decoded: T["decoded"];
    context: T["invocation"]["context"];
    invocations: readonly InvocationResult<T["invocation"]>[];
  }) => MaybePromise<T["response"]>;
  callRuntimeChecks: boolean | (() => boolean) | undefined;
  callSingle: TakibiCall<T["request"], T["response"]>;
  callBatch: TakibiCall<T["request"], T["response"]>;

  invocationCoreRun: BoundRunInvocation<T["invocation"]>;
  localExecution: T["localExecution"];
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

type InvocationCompositionKeys =
  | InvocationAdapterKeys
  | "invocationPolicy"
  | "invocationSchema"
  | "invocationActionHandler"
  | "invocationPrepareApply"
  | "invocationRun";

type CallCompositionKeys =
  | (typeof CALL_SINGLE_ADAPTER_KEYS)[number]
  | (typeof CALL_BATCH_ADAPTER_KEYS)[number]
  | "callSingle"
  | "callBatch";

export type AdapterMap<T extends InternalInvocationTypeMap> = Pick<
  RuntimeAdapterMap<RuntimeTypeMap<T>>,
  InvocationCompositionKeys
>;

export type CallAdapterMap<T extends RuntimeTypeMap = RuntimeTypeMap> = Pick<
  RuntimeAdapterMap<T>,
  InvocationCompositionKeys | CallCompositionKeys
>;

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

export type InvocationPrepareApplyDeps<T extends RuntimeTypeMap = RuntimeTypeMap> = Pick<
  RuntimeAdapterMap<T>,
  (typeof INVOCATION_PREPARE_ADAPTER_KEYS)[number]
>;

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
export type Adapters<T extends RuntimeTypeMap, K extends keyof RuntimeAdapterMap<T>> = Pick<
  RuntimeAdapterMap<T>,
  K
>;

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
  RuntimeTypeMap<T>,
  InvocationAdapterKeys
>;

export type CallFailureStage = "decode" | "resolve" | "dispatch" | "response";

export type CallFailureInput<TRequestLike, TDecoded, TContext> = Readonly<
  { error: unknown; request: TRequestLike } & (
    | { stage: "decode"; decoded?: never; context?: never }
    | { stage: "resolve"; decoded: TDecoded; context?: never }
    | { stage: "dispatch" | "response"; decoded: TDecoded; context: TContext }
  )
>;

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

export type SingleCallAdapters<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = Adapters<
  {
    invocation: TInvocation;
    request: TRequestLike;
    decoded: TDecoded;
    response: TResponseObject;
    localExecution: unknown;
  },
  | "callDecode"
  | "callResolveContext"
  | "callGetWireInvocation"
  | "callToSingleResponse"
  | "callRuntimeChecks"
  | "invocationRun"
>;

export type BatchCallAdapters<
  TRequestLike,
  TDecoded,
  TInvocation extends InternalInvocationTypeMap,
  TResponseObject,
> = Adapters<
  {
    invocation: TInvocation;
    request: TRequestLike;
    decoded: TDecoded;
    response: TResponseObject;
    localExecution: unknown;
  },
  | "callDecode"
  | "callResolveContext"
  | "callGetWireInvocations"
  | "callToBatchResponse"
  | "callRuntimeChecks"
  | "invocationRun"
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
