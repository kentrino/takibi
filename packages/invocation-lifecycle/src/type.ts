export type MaybePromise<T> = T | Promise<T>;

/**
 * The lifecycle only requires transaction-capable storage. Every other runtime
 * capability remains opaque and is projected unchanged through the type map.
 */
export type InvocationRuntime = Readonly<{
  storage: unknown;
}>;

export type InternalInvocationTypeMap = {
  wireInvocation: unknown;
  invocation: unknown;
  runtime: InvocationRuntime;
  context: unknown;
  rawInput: unknown;
  input: unknown;
  noneWork: unknown;
  applyWork: unknown;
  fullWork: unknown;
  nonePrepared: unknown;
  applyPrepared: unknown;
  fullPrepared: unknown;
  result: unknown;
  failure: unknown;
};

export type InvocationCurrentContext<T extends InternalInvocationTypeMap> =
  | T["context"]
  | ("currentContext" extends keyof T ? T["currentContext" & keyof T] : never);

export type InternalInvocationRuntime<T extends InternalInvocationTypeMap> = T["runtime"];
export type InvocationStorage<T extends InternalInvocationTypeMap> = T["runtime"]["storage"];

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
  | Readonly<{ transactionBoundary: "none"; work: TNoneWork }>
  | Readonly<{ transactionBoundary: "apply"; work: TApplyWork }>
  | Readonly<{ transactionBoundary: "full"; work: TFullWork }>;

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
  context: InvocationCurrentContext<T>;
  input: ObservedInput<T["input"]>;
  transactionBoundary: TransactionBoundary | undefined;
  transaction: InternalInvocationSettledTransaction;
}> &
  InvocationCompletion<T["invocation"], T["result"], T["failure"]>;

export type InvocationPlanningView<T extends InternalInvocationTypeMap> = Readonly<{
  wireInvocation: T["wireInvocation"];
  invocation: T["invocation"];
  runtime: T["runtime"];
  context: T["context"];
  input: InvocationInputState<T["rawInput"], T["input"]>;
}>;

export type InvocationResult<T extends InternalInvocationTypeMap> = Readonly<{
  phase: "notified";
  wireInvocation: T["wireInvocation"];
  runtime: T["runtime"];
  context: InvocationCurrentContext<T>;
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
  baseContext: T["context"];
  context: InvocationCurrentContext<T>;
  invocation: T["invocation"];
  plan: InvocationPlan<T>;
  input: InvocationInputState<T["rawInput"], T["input"]>;
  runtime: Omit<T["runtime"], "storage">;
}>;

export type InvocationUpdates<T extends InternalInvocationTypeMap> = Readonly<{
  context?: InvocationCurrentContext<T>;
  input?: InvocationInputState<T["rawInput"], T["input"]>;
}>;

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
    storage: InvocationStorage<T>,
  ): MaybePromise<InvocationAdapterResult<T, TPrepared>>;
  apply(
    state: InvocationExecutionView<T>,
    prepared: TPrepared,
    storage: InvocationStorage<T>,
  ): MaybePromise<InvocationAdapterResult<T, T["result"]>>;
};

export type InvocationTransactionBoundaryContracts<T extends InternalInvocationTypeMap> = {
  none: PrepareApplyInvocationContract<T, T["noneWork"], T["nonePrepared"]>;
  apply: PrepareApplyInvocationContract<T, T["applyWork"], T["applyPrepared"]>;
  full: PrepareApplyInvocationContract<T, T["fullWork"], T["fullPrepared"]>;
};

export type InvocationRequest<T extends InternalInvocationTypeMap> = {
  readonly wireInvocation: T["wireInvocation"];
  readonly context: T["context"];
};

export type InvocationRunOptions<T extends InternalInvocationTypeMap> = {
  readonly request: InvocationRequest<T>;
  readonly invocationRuntimeChecks?: boolean;
};

export type BoundRunInvocation<T extends InternalInvocationTypeMap> = (
  options: InvocationRunOptions<T>,
) => Promise<InvocationResult<T>>;

export type InvocationAdapters<T extends InternalInvocationTypeMap> = {
  invocationRuntime: T["runtime"];
  invocationToInvocation: (wireInvocation: T["wireInvocation"]) => T["invocation"];
  invocationGetRawInput: (wireInvocation: T["wireInvocation"]) => T["rawInput"];
  invocationCreatePlan: (
    view: InvocationPlanningView<T>,
  ) => MaybePromise<InvocationAdapterResult<T, InvocationPlan<T>>>;
  transactionNone: InvocationTransactionBoundaryContracts<T>["none"];
  transactionApply: InvocationTransactionBoundaryContracts<T>["apply"];
  transactionFull: InvocationTransactionBoundaryContracts<T>["full"];
  transactionRun:
    | (<TResult>(work: (storage: InvocationStorage<T>) => Promise<TResult>) => Promise<TResult>)
    | undefined;
  transactionClassifyFailure:
    | ((input: { error: unknown; workCompleted: boolean }) => InternalInvocationTransactionFailure)
    | undefined;
  invocationToFailure: (error: unknown) => T["failure"];
  invocationSnapshotObserverEvent: (
    event: InvocationObserverEvent<T>,
  ) => MaybePromise<InvocationObserverEvent<T>>;
  invocationNotify: ((event: InvocationObserverEvent<T>) => MaybePromise<void>) | undefined;
};

export type RunInvocation = <T extends InternalInvocationTypeMap>(
  adapters: InvocationAdapters<T>,
  options: InvocationRunOptions<T>,
) => Promise<InvocationResult<T>>;
