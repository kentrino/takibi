import { InvocationLifecycleConfigurationError } from "./error";
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
 * Runs one CRUD or action invocation from plan creation through settlement and notification.
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
      error instanceof InvocationLifecycleConfigurationError
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
  TFullPrepared,
  TResult,
>(
  options: ExecutePlanOptions<
    TStorage,
    TNoneWork,
    TApplyWork,
    TFullWork,
    TNonePrepared,
    TApplyPrepared,
    TFullPrepared,
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
  return inTransaction(async (scoped) => {
    const prepared = await options.full.prepare(plan.work, scoped);
    return options.full.apply(prepared, scoped);
  });
}

/**
 * Dispatches a planned invocation to the selected transaction-boundary contract.
 * The runner opens the transaction for `apply` and `full`.
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
      createInvocationTransactionRun(
        state,
        adapters.transactionRun,
        adapters.transactionClassifyFailure,
        setFailureStage,
      )(({ storage }) => work(storage)),
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
      prepare: async (work, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionFull.prepare(state.executionView(), work, storage),
        ),
      apply: async (prepared, storage) =>
        state.acceptAdapterResult(
          await adapters.transactionFull.apply(state.executionView(), prepared, storage),
        ),
    },
  });
};

/**
 * Runs one transaction at the plan-selected boundary while tracking commit and rollback state.
 * Rejects missing or repeated transaction entry.
 */
const createInvocationTransactionRun = function <T extends InternalInvocationTypeMap>(
  state: InvocationState<T>,
  runInTransaction:
    | (<TResult>(work: (storage: T["runtime"]["storage"]) => Promise<TResult>) => Promise<TResult>)
    | undefined,
  classifyFailure:
    | ((input: { error: unknown; workCompleted: boolean }) => {
        stage: InternalInvocationFailureStage;
        transaction: "rolled-back" | "unknown";
      })
    | undefined,
  setFailureStage: (stage: InternalInvocationFailureStage) => void,
): <TResult>(
  work: (scope: { readonly storage: T["runtime"]["storage"] }) => MaybePromise<TResult>,
) => Promise<TResult> {
  let used = false;
  return async function run<TResult>(
    work: (scope: { readonly storage: T["runtime"]["storage"] }) => MaybePromise<TResult>,
  ): Promise<TResult> {
    if (used) {
      throw new InvocationLifecycleConfigurationError(
        "Invocation transaction scope may only run once",
      );
    }
    used = true;
    if (runInTransaction === undefined) {
      throw new InvocationLifecycleConfigurationError(
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
  };
};
