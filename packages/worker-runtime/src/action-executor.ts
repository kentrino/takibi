import { ActionRegistry, type CollectionsDef } from "@takibi/api";
import type { JsonValue } from "@takibi/shared-types";
import {
  executePlan,
  unwrapInvocationAdapterResult,
  type InvocationExecutionView,
} from "@takibi/invocation-lifecycle";
import { classifyAction } from "./action-resolution";
import { createTakibiActionPlan } from "./invocation-plan";
import { toTakibiInvocation } from "./invocation-adapters";
import {
  createInvocationPrepareApply,
  type InvocationPrepareApply,
} from "./invocation-prepare-apply";
import type { InternalLogger } from "./logging";
import type { StorageDriver } from "@takibi/storage";
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
  const plan = createTakibiActionPlan(classifyAction(registry, invocation));
  const { work } = plan;
  const view: InvocationExecutionView<TakibiInvocationTypeMap<TCtx>> = {
    baseContext: ctx,
    context: ctx,
    invocation: toTakibiInvocation(invocation),
    plan,
    input: Object.prototype.hasOwnProperty.call(invocation, "input")
      ? { status: "raw", value: invocation.input }
      : { status: "not-applicable" },
    runtime: { collections, registry, logger, services },
  };
  const bound = {
    prepare: async (_work: TakibiActionWork, scopedStorage: StorageDriver) =>
      unwrapInvocationAdapterResult(await prepareApply.prepare(view, work, scopedStorage)),
    apply: async (
      prepared: Extract<TakibiPrepared<TCtx>, { kind: "action" }>,
      scopedStorage: StorageDriver,
    ) => unwrapInvocationAdapterResult(await prepareApply.apply(view, prepared, scopedStorage)),
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
