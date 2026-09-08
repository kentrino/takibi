import { TakibiContractConfigurationError } from "./request";
import { InvocationState } from "./state";
import {
  type ExecutePlanOptions,
  type InternalInvocationFailureStage,
  type InternalInvocationTypeMap,
  type InvocationAdapters,
  type InvocationResult,
  type InvocationRunOptions,
  type MaybePromise,
  type RunInvocation,
} from "./type";

export { TakibiContractConfigurationError };

const safeToFailure = <TFailure>(
  toFailure: (error: unknown) => TFailure,
  error: unknown,
): import("./type").InternalInvocationFailure<TFailure> => {
  try {
    return { kind: "mapped", value: toFailure(error) };
  } catch (mappingError) {
    return { kind: "mapping-failed", error: mappingError, cause: error };
  }
};

/**
 * 日本語: 1件のCRUD・actionについて、計画作成から実行、成否確定、通知まで進める。
 * English: Runs one CRUD or action invocation from plan creation through settlement and notification.
 *
 * Production Takibi binds its adapters in `takibi-worker-runtime/src/invocation-adapters.ts`
 * and calls this runner from `takibi-worker-runtime/src/invocation-execution.ts`.
 */
export const runInvocation: RunInvocation = async function <T extends InternalInvocationTypeMap>(
  {
    invocationRuntime,
    invocationToInvocation,
    invocationGetRawInput,
    invocationCreatePlan,
    transactionNone,
    transactionApply,
    transactionFull,
    transactionRun,
    transactionClassifyFailure,
    invocationToFailure,
    invocationSnapshotObserverEvent,
    invocationNotify,
  }: InvocationAdapters<T>,
  { request, invocationRuntimeChecks }: InvocationRunOptions<T>,
): Promise<InvocationResult<T>> {
  const state = new InvocationState(request, invocationRuntime, invocationRuntimeChecks ?? true);
  state.start();

  let failureStage: InternalInvocationFailureStage = "classify";
  try {
    const initialization = state.initializationView();
    state.acceptInvocation(invocationToInvocation(initialization.wireInvocation));
    state.acceptRawInput(invocationGetRawInput(initialization.wireInvocation));
    state.acceptPlan(await invocationCreatePlan(state.planningView()));
    failureStage = "execute";
    const result = await executeInvocationPlan(
      state,
      {
        transactionNone,
        transactionApply,
        transactionFull,
        transactionRun,
        transactionClassifyFailure,
      },
      (stage) => {
        failureStage = stage;
      },
    );
    state.succeed(result);
  } catch (error) {
    state.fail(
      failureStage,
      error instanceof TakibiContractConfigurationError
        ? { kind: "configuration", error }
        : safeToFailure(invocationToFailure, error),
    );
  }

  const observerEvent = state.observerEvent();
  if (!state.beginNotification()) return state.result();
  if (invocationNotify === undefined) {
    state.finishNotification({ outcome: "skipped" });
  } else {
    try {
      await invocationNotify(await invocationSnapshotObserverEvent(observerEvent));
      state.finishNotification({ outcome: "succeeded" });
    } catch (error) {
      state.finishNotification({ outcome: "failed", error });
    }
  }
  return state.result();
};

/**
 * Executes an already-created plan while preserving thrown values and errors.
 * Settlement and notification belong only to the top-level invocation runner.
 */
export async function executePlan<
  TStorage,
  TNoneWork,
  TApplyWork,
  TFullWork,
  TNonePrepared,
  TApplyPrepared,
  TResult,
>(
  options: ExecutePlanOptions<
    TStorage,
    TNoneWork,
    TApplyWork,
    TFullWork,
    TNonePrepared,
    TApplyPrepared,
    TResult
  >,
): Promise<TResult> {
  const { plan, storage } = options;
  const inTransaction = <T>(work: (scoped: TStorage) => MaybePromise<T>): Promise<T> =>
    options.reuseTransaction ? Promise.resolve(work(storage)) : options.runInTransaction(work);

  if (plan.transactionBoundary === "none") {
    const prepared = await options.none.prepare(plan.work, storage);
    return options.none.apply(prepared, storage);
  }
  if (plan.transactionBoundary === "apply") {
    const prepared = await options.apply.prepare(plan.work, storage);
    return inTransaction((scoped) => options.apply.apply(prepared, scoped));
  }
  return inTransaction((scoped) => options.full.prepareAndApply(plan.work, scoped));
}

/**
 * 日本語: 計画のtransactionBoundaryに従い、none / apply / fullへ振り分ける。
 * English: Dispatches a planned invocation to the none, apply, or full contract.
 *
 * Relation to current Takibi / 現行Takibiとの関係:
 * - Transaction-boundary contracts replace action/collection executor switching.
 * - The runner opens the transaction for `apply` and `full`.
 */
const executeInvocationPlan = async function <T extends InternalInvocationTypeMap>(
  state: InvocationState<T>,
  adapters: Pick<
    InvocationAdapters<T>,
    | "transactionNone"
    | "transactionApply"
    | "transactionFull"
    | "transactionRun"
    | "transactionClassifyFailure"
  >,
  setFailureStage: (stage: InternalInvocationFailureStage) => void,
): Promise<T["result"]> {
  const base = state.storage();
  return executePlan({
    plan: state.executionView().plan,
    storage: base,
    runInTransaction: (work) =>
      createInvocationTransactionScope(
        state,
        adapters.transactionRun,
        adapters.transactionClassifyFailure,
        setFailureStage,
      ).run(({ storage }) => work(storage)),
    none: {
      prepare: async (work, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionNone.prepare(state.executionView(), work, storage),
        ),
      apply: async (prepared, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionNone.apply(state.executionView(), prepared, storage),
        ),
    },
    apply: {
      prepare: async (work, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionApply.prepare(state.executionView(), work, storage),
        ),
      apply: async (prepared, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionApply.apply(state.executionView(), prepared, storage),
        ),
    },
    full: {
      prepareAndApply: async (work, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionFull.prepareAndApply(state.executionView(), work, storage),
        ),
    },
  });
};

/**
 * 日本語: 計画が選んだ境界でtransactionを一度だけ実行し、commit・rollback stateをrunner側で管理する。
 * English: Runs one transaction at the plan-selected boundary while the runner owns commit and rollback state.
 *
 * Production adapters delegate the callback to `StorageDriver.transaction`; this scope records the
 * invocation-level transaction outcome and rejects missing or repeated transaction entry.
 */
const createInvocationTransactionScope = function <T extends InternalInvocationTypeMap>(
  state: InvocationState<T>,
  runInTransaction:
    | (<TResult>(work: (storage: T["storage"]) => Promise<TResult>) => Promise<TResult>)
    | undefined,
  classifyFailure:
    | ((input: { error: unknown; workCompleted: boolean }) => {
        stage: InternalInvocationFailureStage;
        transaction: "rolled-back" | "unknown";
      })
    | undefined,
  setFailureStage: (stage: InternalInvocationFailureStage) => void,
): {
  transactionBoundary: "none" | "apply" | "full";
  wasUsed: () => boolean;
  run<TResult>(
    work: (scope: { readonly storage: T["storage"] }) => MaybePromise<TResult>,
  ): Promise<TResult>;
} {
  let used = false;
  return {
    transactionBoundary: state.transactionBoundary(),
    wasUsed: () => used,
    async run<TResult>(
      work: (scope: { readonly storage: T["storage"] }) => MaybePromise<TResult>,
    ): Promise<TResult> {
      if (used) {
        throw new TakibiContractConfigurationError(
          "Invocation transaction scope may only run once",
        );
      }
      used = true;
      if (runInTransaction === undefined) {
        throw new TakibiContractConfigurationError(
          "Transactional invocation requires runInTransaction",
        );
      }

      state.beginTransaction();
      let workCompleted = false;
      try {
        const result = await runInTransaction(async (storage) => {
          const value = await work({ storage });
          workCompleted = true;
          return value;
        });
        state.completeTransaction();
        return result;
      } catch (error) {
        const failure = classifyFailure?.({ error, workCompleted }) ?? {
          stage: workCompleted ? ("commit" as const) : ("execute" as const),
          transaction: "unknown" as const,
        };
        setFailureStage(failure.stage);
        state.abortTransaction(failure.transaction);
        throw error;
      }
    },
  };
};
