import type {
  ActionRegistry,
  CollectionsDef,
  RuntimeActionDefinition,
} from "@takibi/takibi-api";
import type { CollectionOperation } from "@takibi/takibi-policy";
import type {
  JsonValue,
  ObserverInvocationData,
  TakibiFailure,
} from "@takibi/takibi-shared-types";
import type { StorageDriver } from "@takibi/takibi-storage";
import type { ActionInvocation, ResolvedAction } from "./action-executor";
import type { ExecuteRequest, ResolvedCollection } from "./executor";
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

export type TakibiInvocationOperation =
  | Readonly<{ kind: "action"; scope: string; name: string }>
  | Readonly<{
      kind: "collection";
      collection: string;
      operation: CollectionOperation;
    }>;

export type TakibiActionWork = Readonly<{
  kind: "action";
  operation: TakibiInvocationOperation;
  capability: "may-write";
  invocation: ActionInvocation;
  definition: RuntimeActionDefinition;
}>;

export type TakibiCollectionWork = Readonly<{
  kind: "collection";
  operation: TakibiInvocationOperation;
  capability: "read-only" | "writes";
  request: ExecuteRequest;
}>;

export type TakibiNoneWork = TakibiActionWork | TakibiCollectionWork;
export type TakibiApplyWork = TakibiActionWork | TakibiCollectionWork;
export type TakibiFullWork = TakibiActionWork;

export type TakibiPrepared<TContext extends object> =
  | Readonly<{ kind: "action"; resolved: ResolvedAction<TContext> }>
  | Readonly<{ kind: "collection"; resolved: ResolvedCollection<TContext> }>;

/**
 * One type map for Durable Object `fetch` and in-process execution.
 * Worker stub transport does not bind invocation adapters, so it does not
 * instantiate this map.
 */
export type TakibiInvocationTypeMap<TContext extends object = object, TServices = unknown> = {
  wireInvocation: TakibiWireInvocation;
  invocation: TakibiPublicInvocation;
  collections: CollectionsDef<TContext>;
  storage: StorageDriver;
  registry: ActionRegistry;
  context: TContext;
  logger: InternalLogger | undefined;
  services: TServices;
  rawInput: unknown;
  input: unknown;
  noneWork: TakibiNoneWork;
  applyWork: TakibiApplyWork;
  fullWork: TakibiFullWork;
  nonePrepared: TakibiPrepared<TContext>;
  applyPrepared: TakibiPrepared<TContext>;
  fullPrepared: TakibiPrepared<TContext>;
  result: JsonValue;
  failure: TakibiFailure<string>;
};
