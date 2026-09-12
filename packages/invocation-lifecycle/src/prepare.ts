import type {
  InternalInvocationTypeMap,
  InvocationAdapterResult,
  InvocationUpdates,
  MaybePromise,
} from "./type";

export function mergeInvocationUpdates<T extends InternalInvocationTypeMap>(
  first?: InvocationUpdates<T>,
  second?: InvocationUpdates<T>,
): InvocationUpdates<T> | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  const merged = { ...first, ...second };
  if (merged.context === undefined && Object.hasOwn(first, "context")) {
    merged.context = first.context;
  }
  if (merged.input === undefined && Object.hasOwn(first, "input")) {
    merged.input = first.input;
  }
  return merged;
}

/**
 * Accepts a throwing stage as an adapter result. Success may record updates;
 * failure keeps the original error identity and does not invent updates.
 */
export async function invocationStageResult<T extends InternalInvocationTypeMap, TValue>(
  run: () => MaybePromise<TValue>,
  updates?: (value: TValue) => InvocationUpdates<T> | undefined,
): Promise<InvocationAdapterResult<T, TValue>> {
  try {
    const value = await run();
    const recorded = updates?.(value);
    return recorded === undefined
      ? { outcome: "succeeded", value }
      : { outcome: "succeeded", value, updates: recorded };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

/**
 * Direct-path boundary: rethrow the original failure or return the value.
 * Top-level settlement uses `InvocationState.acceptAdapterResult` instead.
 */
export function unwrapInvocationAdapterResult<T extends InternalInvocationTypeMap, TValue>(
  result: InvocationAdapterResult<T, TValue>,
): TValue {
  if (result.outcome === "failed") throw result.error;
  return result.value;
}
