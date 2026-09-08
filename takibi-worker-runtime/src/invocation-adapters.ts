import { NotFoundError } from "@takibi/takibi-api";
import type {
  InternalInvocationRuntime,
  InvocationAdapterResult,
  InvocationAdapters,
  InvocationObserverEvent,
  InvocationPlan,
  InvocationPlanningView,
} from "@takibi/takibi-worker-runtime-contract";
import type { ActionInvocation } from "./action-gate";
import { classifyAction } from "./action-executor";
import { toWireFailure } from "./context/runtime";
import type { ExecuteRequest } from "./executor";
import { createInvocationTransactionBoundaryContracts } from "./invocation-paths";
import { actionExecutionPlan, collectionExecutionPlan } from "./transaction-boundary";
import type {
  TakibiActionWork,
  TakibiCollectionWork,
  TakibiInvocationTypeMap,
  TakibiPublicInvocation,
  TakibiWireInvocation,
} from "./invocation-type-map";

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;
export function toTakibiInvocation(wireInvocation: TakibiWireInvocation): TakibiPublicInvocation {
  if (wireInvocation.kind === "action") {
    const { input: _input, ...invocation } = wireInvocation;
    return invocation;
  }
  if ("input" in wireInvocation) {
    const { input: _input, ...invocation } = wireInvocation;
    return invocation;
  }
  return wireInvocation;
}

export function getTakibiRawInput(wireInvocation: TakibiWireInvocation): unknown {
  return "input" in wireInvocation ? wireInvocation.input : undefined;
}

export function createBoundInvocationAdapters<TContext extends object, TServices = unknown>(
  runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>,
): InvocationAdapters<TakibiMap<TContext, TServices>> {
  const transactionBoundary = createInvocationTransactionBoundaryContracts(runtime);
  return {
    invocationRuntime: runtime,
    invocationToInvocation: toTakibiInvocation,
    invocationGetRawInput: getTakibiRawInput,
    invocationCreatePlan: createTakibiInvocationPlan,
    transactionNone: transactionBoundary.none,
    transactionApply: transactionBoundary.apply,
    transactionFull: transactionBoundary.full,
    transactionRun: (work) => runtime.storage.transaction(work),
    transactionClassifyFailure: undefined,
    invocationToFailure: toWireFailure,
    invocationSnapshotObserverEvent: snapshotTakibiObserverEvent,
    invocationNotify: undefined,
  };
}

/**
 * Takibi invocation values cross JSON-compatible request/result boundaries, so the runtime can
 * detach their observer view. Services deliberately retain identity because they are capabilities,
 * not serializable invocation data.
 */
export function snapshotTakibiObserverEvent<TContext extends object, TServices>(
  event: InvocationObserverEvent<TakibiMap<TContext, TServices>>,
): InvocationObserverEvent<TakibiMap<TContext, TServices>> {
  const { services, ...detachable } = event;
  return Object.freeze({
    ...structuredClone(detachable),
    services,
  }) as InvocationObserverEvent<TakibiMap<TContext, TServices>>;
}

export async function createTakibiInvocationPlan<TContext extends object, TServices>(
  view: InvocationPlanningView<TakibiMap<TContext, TServices>>,
): Promise<
  InvocationAdapterResult<
    TakibiMap<TContext, TServices>,
    InvocationPlan<TakibiMap<TContext, TServices>>
  >
> {
  const wire = view.wireInvocation;
  if (wire.kind === "action") {
    try {
      return { outcome: "succeeded", value: writeActionIdentity(view, wire) };
    } catch (error) {
      return { outcome: "failed", error };
    }
  }
  try {
    return { outcome: "succeeded", value: writeCollectionIdentity(view, wire) };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

function writeActionIdentity<TContext extends object, TServices>(
  state: Pick<
    InvocationPlanningView<TakibiMap<TContext, TServices>>,
    "wireInvocation" | "runtime" | "context" | "input"
  >,
  invocation: ActionInvocation,
): InvocationPlan<TakibiMap<TContext, TServices>> {
  return actionIdentity(classifyAction(state.runtime.registry, invocation));
}

function writeCollectionIdentity<TContext extends object, TServices>(
  state: Pick<
    InvocationPlanningView<TakibiMap<TContext, TServices>>,
    "runtime" | "context" | "input"
  >,
  req: ExecuteRequest,
): InvocationPlan<TakibiMap<TContext, TServices>> {
  if (!state.runtime.collections[req.collection]) {
    throw new NotFoundError(`Unknown collection: ${req.collection}`);
  }
  return collectionIdentity(req);
}

function actionIdentity<TContext extends object, TServices>(
  classified: ReturnType<typeof classifyAction>,
): InvocationPlan<TakibiMap<TContext, TServices>> {
  const { invocation, definition } = classified;
  const work: TakibiActionWork = {
    kind: "action" as const,
    operation: {
      kind: "action" as const,
      scope: invocation.scope,
      name: invocation.name,
    },
    capability: "may-write" as const,
    invocation,
    definition,
  };
  return actionExecutionPlan(work);
}

function collectionIdentity<TContext extends object, TServices>(
  req: ExecuteRequest,
): InvocationPlan<TakibiMap<TContext, TServices>> {
  const work: TakibiCollectionWork = {
    kind: "collection",
    operation: {
      kind: "collection",
      collection: req.collection,
      operation: req.operation,
    },
    capability:
      req.operation === "get" || req.operation === "list" || req.operation === "count"
        ? "read-only"
        : "writes",
    request: req,
  };
  return collectionExecutionPlan(work);
}
