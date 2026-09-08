import { TakibiContractConfigurationError } from "./request";
import type { LocalCallRequest } from "./type";

export function decodeLocalCallRequest<TContext, TWireInvocation, TBatchItem = TWireInvocation>(
  request: LocalCallRequest<TContext, TWireInvocation, TBatchItem>,
): LocalCallRequest<TContext, TWireInvocation, TBatchItem> {
  return request;
}

export function resolveLocalCallContext<TContext, TWireInvocation, TBatchItem>(input: {
  decoded: LocalCallRequest<TContext, TWireInvocation, TBatchItem>;
}): TContext {
  return input.decoded.context;
}

export function getLocalCallWireInvocation<TContext, TWireInvocation, TBatchItem>(input: {
  decoded: LocalCallRequest<TContext, TWireInvocation, TBatchItem>;
}): TWireInvocation {
  if (input.decoded.kind !== "single") {
    throw new TakibiContractConfigurationError("Single call received a batch input");
  }
  return input.decoded.invocation;
}

export function getLocalCallWireInvocations<TContext, TWireInvocation, TBatchItem>(input: {
  decoded: LocalCallRequest<TContext, TWireInvocation, TBatchItem>;
}): readonly TBatchItem[] {
  if (input.decoded.kind !== "batch") {
    throw new TakibiContractConfigurationError("Batch call received a single input");
  }
  return input.decoded.items;
}

export function localSingleCall<TContext, TWireInvocation>(
  context: TContext,
  invocation: TWireInvocation,
): Extract<LocalCallRequest<TContext, TWireInvocation>, { kind: "single" }> {
  return { kind: "single", context, invocation };
}

export function localBatchCall<TContext, TBatchItem>(
  context: TContext,
  items: readonly TBatchItem[],
): Extract<LocalCallRequest<TContext, unknown, TBatchItem>, { kind: "batch" }> {
  return { kind: "batch", context, items };
}
