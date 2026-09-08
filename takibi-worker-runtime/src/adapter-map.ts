import type { AdapterMap } from "@takibi/takibi-worker-runtime-contract";
import { normalizeInvocationFailure } from "./context/runtime";
import {
  createTakibiInvocationPlan,
  getTakibiRawInput,
  snapshotTakibiObserverEvent,
  toTakibiInvocation,
} from "./invocation-adapters";
import { createInvocationTransactionBoundaryContracts } from "./invocation-paths";
import type { TakibiInvocationTypeMap } from "./invocation-type-map";

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;

/**
 * Contract `AdapterMap` pinned to Takibi's invocation type map.
 */
export type TakibiAdapterMap<TContext extends object, TServices = unknown> = AdapterMap<
  TakibiMap<TContext, TServices>
>;

export function createTakibiInvocationAdapterFactories<
  TContext extends object,
  TServices = unknown,
>() {
  return {
    invocationToInvocation: () => toTakibiInvocation,
    invocationGetRawInput: () => getTakibiRawInput,
    invocationCreatePlan: () => createTakibiInvocationPlan,
    invocationTransactionBoundary: ({
      invocationRuntime,
    }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationRuntime">) =>
      createInvocationTransactionBoundaryContracts(invocationRuntime),
    transactionNone: ({
      invocationTransactionBoundary,
    }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationTransactionBoundary">) =>
      invocationTransactionBoundary.none,
    transactionApply: ({
      invocationTransactionBoundary,
    }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationTransactionBoundary">) =>
      invocationTransactionBoundary.apply,
    transactionFull: ({
      invocationTransactionBoundary,
    }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationTransactionBoundary">) =>
      invocationTransactionBoundary.full,
    transactionRun:
      ({ invocationRuntime }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationRuntime">) =>
      <TResult>(work: (storage: TakibiMap<TContext, TServices>["storage"]) => Promise<TResult>) =>
        invocationRuntime.storage.transaction(work),
    transactionClassifyFailure: () => undefined,
    invocationToFailure: () => normalizeInvocationFailure,
    invocationSnapshotObserverEvent: () => snapshotTakibiObserverEvent,
    invocationNotify: () => undefined,
  };
}
