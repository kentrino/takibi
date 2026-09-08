import type {
  InternalInvocationRuntime,
  PrepareApplyInvocationContract,
} from "@takibi/takibi-worker-runtime-contract";
import {
  createInvocationPrepareApply,
  type InvocationPrepareApplyDeps,
} from "./invocation-prepare-apply";
import type {
  TakibiApplyWork,
  TakibiFullWork,
  TakibiInvocationTypeMap,
  TakibiNoneWork,
  TakibiPrepared,
} from "./invocation-type-map";

export {
  createInvocationPrepareApply,
  InvocationPrepareApply,
  type InvocationPrepareApplyDeps,
} from "./invocation-prepare-apply";

export function createInvocationTransactionBoundaryContracts<TContext extends object, TServices>(
  runtime: InternalInvocationRuntime<TakibiInvocationTypeMap<TContext, TServices>>,
  adapters?: Partial<InvocationPrepareApplyDeps>,
): {
  none: PrepareApplyInvocationContract<
    TakibiInvocationTypeMap<TContext, TServices>,
    TakibiNoneWork,
    TakibiPrepared<TContext>
  >;
  apply: PrepareApplyInvocationContract<
    TakibiInvocationTypeMap<TContext, TServices>,
    TakibiApplyWork,
    TakibiPrepared<TContext>
  >;
  full: PrepareApplyInvocationContract<
    TakibiInvocationTypeMap<TContext, TServices>,
    TakibiFullWork,
    TakibiPrepared<TContext>
  >;
} {
  const prepareApply = createInvocationPrepareApply<TContext, TServices>({
    logger: runtime.logger,
    ...adapters,
  });
  return {
    none: prepareApply,
    apply: prepareApply,
    full: prepareApply,
  };
}
