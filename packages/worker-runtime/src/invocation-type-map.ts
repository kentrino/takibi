import type { ActionRegistry, CollectionsDef, RuntimeActionDefinition } from "@takibi/api";
import type { JsonValue, ObserverInvocationData, TakibiFailure } from "@takibi/shared-types";
import type { StorageDriver } from "@takibi/storage";
import type { ActionInvocation, ResolvedAction } from "./action-executor";
import type { executeResolvedCollection, ExecuteRequest, ResolvedCollection } from "./executor";
import type { InternalLogger } from "./logging";
import type { CollectionReadRequest } from "./protocol";

/**
 * Single-item wire payload for Durable Object and in-process execution.
 * Not a batch envelope and not the `{ context, ...item }` wire wrapper.
 */
export type TakibiWireInvocation = ActionInvocation | ExecuteRequest | CollectionReadRequest;

/**
 * Observer-safe copy of {@link TakibiWireInvocation}. Raw client input stays
 * on `rawInput` via `getRawInput`, not here.
 */
export type TakibiPublicInvocation = ObserverInvocationData;

export type TakibiActionWork = Readonly<{
  kind: "action";
  invocation: ActionInvocation;
  definition: RuntimeActionDefinition;
}>;

export type TakibiCollectionWork = Readonly<{
  kind: "collection";
  request: ExecuteRequest;
}>;

export type TakibiNoneWork = TakibiActionWork | TakibiCollectionWork;
export type TakibiApplyWork = TakibiActionWork | TakibiCollectionWork;
export type TakibiFullWork = TakibiActionWork | TakibiCollectionWork;

export type TakibiPrepared<TContext extends object> =
  | Readonly<{ kind: "action"; resolved: ResolvedAction<TContext> }>
  | Readonly<{ kind: "collection"; resolved: ResolvedCollection<TContext> }>;

/**
 * Concrete collaborator bag for Durable Object and in-process execution.
 * Independent of input, result, and work types on the invocation map.
 */
export type TakibiInvocationRuntime<
  TContext extends object = object,
  TServices = unknown,
> = Readonly<{
  collections: CollectionsDef<TContext>;
  storage: StorageDriver;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: TServices;
}>;

/**
 * One type map for Durable Object `fetch` and in-process execution.
 * Worker stub transport does not bind invocation adapters, so it does not
 * instantiate this map.
 */
export type TakibiInvocationTypeMap<TContext extends object = object, TServices = unknown> = {
  wireInvocation: TakibiWireInvocation;
  invocation: TakibiPublicInvocation;
  runtime: TakibiInvocationRuntime<TContext, TServices>;
  context: TContext;
  /** Guard output published through action lifecycle updates. */
  currentContext: unknown;
  rawInput: unknown;
  input: unknown;
  noneWork: TakibiNoneWork;
  applyWork: TakibiApplyWork;
  fullWork: TakibiFullWork;
  nonePrepared: TakibiPrepared<TContext>;
  applyPrepared: TakibiPrepared<TContext>;
  fullPrepared: TakibiPrepared<TContext>;
  result: JsonValue | Awaited<ReturnType<typeof executeResolvedCollection>>;
  failure: TakibiFailure<string>;
};
