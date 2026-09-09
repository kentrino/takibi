import { NotFoundError } from "@takibi/takibi-api";
import {
  type InvocationAdapterResult,
  type InvocationObserverEvent,
  type InvocationPlan,
  type InvocationPlanningView,
} from "@takibi/takibi-worker-runtime-contract";
import { classifyAction } from "./action-resolution";
import { createTakibiActionPlan, createTakibiCollectionPlan } from "./invocation-plan";
import type {
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

/**
 * Takibi invocation values cross JSON-compatible request/result boundaries, so the runtime can
 * detach their observer view. Services are bound on the observer, not cloned from the event.
 */
export function snapshotTakibiObserverEvent<TContext extends object, TServices>(
  event: InvocationObserverEvent<TakibiMap<TContext, TServices>>,
): InvocationObserverEvent<TakibiMap<TContext, TServices>> {
  return Object.freeze(structuredClone(event));
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
  try {
    if (wire.kind === "action") {
      return {
        outcome: "succeeded",
        value: createTakibiActionPlan(classifyAction(view.runtime.registry, wire)),
      };
    }
    if (!view.runtime.collections[wire.collection]) {
      throw new NotFoundError(`Unknown collection: ${wire.collection}`);
    }
    return { outcome: "succeeded", value: createTakibiCollectionPlan(wire) };
  } catch (error) {
    return { outcome: "failed", error };
  }
}
