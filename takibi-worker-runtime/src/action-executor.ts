import { ActionRegistry, type CollectionsDef } from "@takibi/takibi-api";
import type { JsonValue } from "@takibi/takibi-shared-types";
import {
  createActionExecutionPlan,
  executePlan,
  unwrapInvocationAdapterResult,
  type InvocationExecutionView,
} from "@takibi/takibi-worker-runtime-contract";
import { classifyAction } from "./action-resolution";
import { toTakibiInvocation } from "./invocation-adapters";
import {
  createInvocationPrepareApply,
  type InvocationPrepareApply,
} from "./invocation-prepare-apply";
import type { InternalLogger } from "./logging";
import type { StorageDriver } from "@takibi/takibi-storage";
import type { ActionInvocation } from "./action-gate";
import type {
  TakibiActionWork,
  TakibiInvocationTypeMap,
  TakibiPrepared,
} from "./invocation-type-map";

export type { ActionInvocation } from "./action-gate";
export { resolveGateGrant } from "./action-gate";
export {
  authorizeIdentifiedAction,
  classifyAction,
  executeResolvedAction,
  identifyAction,
  identifyClassifiedAction,
  parseIdentifiedAction,
  resolveAction,
  type AuthorizedAction,
  type ClassifiedAction,
  type IdentifiedAction,
  type ResolvedAction,
} from "./action-resolution";

/**
 * Run a registered action. The envelope must already be a valid
 * `ActionInvocation` from `decodeWireRequest` (or an equivalent trusted
 * constructor). This function does not re-check wire shape.
 *
 * Preparation and apply go through the same `InvocationPrepareApply` as
 * top-level invocation. This entry throws the original adapter error.
 */
export async function executeAction<TCtx extends object>(
  registry: ActionRegistry,
  collections: CollectionsDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  invocation: ActionInvocation,
  logger?: InternalLogger,
  services: unknown = {},
  prepareApply: InvocationPrepareApply<TCtx> = createInvocationPrepareApply({ logger }),
): Promise<JsonValue> {
  const classified = classifyAction(registry, invocation);
  const work: TakibiActionWork = {
    kind: "action",
    operation: { kind: "action", scope: invocation.scope, name: invocation.name },
    capability: "may-write",
    invocation,
    definition: classified.definition,
  };
  const plan = createActionExecutionPlan(
    {
      kind: "action",
      target: classified.definition.target,
      atomic: classified.definition.atomic,
    },
    work,
  );
  const view: InvocationExecutionView<TakibiInvocationTypeMap<TCtx>> = {
    context: ctx,
    invocation: toTakibiInvocation(invocation),
    plan,
    input: Object.prototype.hasOwnProperty.call(invocation, "input")
      ? { status: "raw", value: invocation.input }
      : { status: "not-applicable" },
    runtime: { collections, logger, services },
  };
  const bound = {
    prepare: async (_work: TakibiActionWork, scopedStorage: StorageDriver) =>
      unwrapInvocationAdapterResult(await prepareApply.prepare(view, work, scopedStorage)),
    apply: async (prepared: TakibiPrepared<TCtx>, scopedStorage: StorageDriver) =>
      unwrapInvocationAdapterResult(await prepareApply.apply(view, prepared, scopedStorage)),
  };

  return executePlan({
    plan,
    storage,
    runInTransaction: (callback) =>
      storage.transaction(async (scopedStorage) => callback(scopedStorage)),
    none: bound,
    apply: bound,
    full: bound,
  });
}
