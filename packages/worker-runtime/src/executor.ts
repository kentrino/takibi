import type { CollectionsDef } from "@takibi/api";
import type { StorageDriver } from "@takibi/storage";
import { executePlan } from "@takibi/worker-runtime-contract";
import {
  prepareCollection,
  type ExecuteRequest,
  type PreparedCollection,
} from "@takibi/operations";
import { createTakibiCollectionPlan } from "./invocation-plan";
import { createInvocationCollaborators } from "./invocation-collaborators";
import { createDocumentBuilder } from "./typed-storage";
import type { InternalLogger } from "./logging";
import type { TakibiCollectionWork } from "./invocation-type-map";

export type { ExecuteRequest } from "@takibi/operations";

export function executeOperation<TCtx extends object>(
  collections: CollectionsDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  req: ExecuteRequest,
  logger?: InternalLogger,
) {
  return executeOperationInScope(collections, storage, ctx, req, logger, false);
}

/** Coordinate the preparation phase and the transaction scope used to apply it. */
export function executeOperationInScope<TCtx extends object>(
  collections: CollectionsDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  req: ExecuteRequest,
  logger: InternalLogger | undefined,
  reuseTransaction: boolean,
) {
  const adapters = {
    policy: createInvocationCollaborators({ logger }).policy,
    documents: createDocumentBuilder(logger),
  };
  const prepare = (_work: TakibiCollectionWork, scoped: StorageDriver) =>
    prepareCollection({ collections, storage: scoped, ctx, req }, adapters);
  const apply = (prepared: PreparedCollection<TCtx>, scoped: StorageDriver) =>
    prepared.apply(scoped);
  return executePlan({
    plan: createTakibiCollectionPlan(req),
    storage,
    reuseTransaction,
    runInTransaction: (callback) => storage.transaction(async (scoped) => callback(scoped)),
    none: { prepare, apply },
    apply: { prepare, apply },
    full: { prepare, apply },
  });
}
