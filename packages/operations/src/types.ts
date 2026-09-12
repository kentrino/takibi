import type { CollectionDefinition, CollectionsDef } from "@takibi/api";
import type { AccessGrant } from "@takibi/policy";
import type { CollectionRequestData, WithMetadata } from "@takibi/shared-types";
import type { StorageDriver } from "@takibi/storage";
import type { PolicySurface } from "@takibi/worker-runtime-contract";

export type ExecuteRequest = CollectionRequestData;

/** Dependencies shared by an operation's invocations. */
export type OperationAdapters = {
  readonly policy: Pick<PolicySurface, "evaluateCollection">;
  readonly documents: DocumentBuilder;
};

/** Input and storage scope for a single invocation. */
export type OperationContext<TCtx extends object> = {
  readonly req: ExecuteRequest;
  readonly ctx: TCtx;
  readonly def: CollectionDefinition;
  readonly collections: CollectionsDef<TCtx>;
  readonly storage: StorageDriver;
};

export type OperationState<TCtx extends object> = OperationContext<TCtx> & {
  readonly grant: AccessGrant;
  readonly existing?: WithMetadata<Record<string, unknown>> | null;
  readonly nextDoc?: WithMetadata<Record<string, unknown>>;
};

export type CollectionOperationResult =
  | WithMetadata<Record<string, unknown>>
  | { id: string; updatedAt: string; rev: number }
  | { id: string }
  | Awaited<ReturnType<StorageDriver["list"]>>
  | number
  | null
  | undefined;

/** Operations own collection semantics; the caller owns transaction scope. */
export interface CollectionOperationHandler {
  prepare<TCtx extends object>(context: OperationContext<TCtx>): Promise<OperationState<TCtx>>;
  apply<TCtx extends object>(state: OperationState<TCtx>): Promise<CollectionOperationResult>;
}

/** Builds validated document candidates without persisting them. */
export interface DocumentBuilder {
  buildAdd(
    def: CollectionDefinition,
    input: unknown,
    options?: { id?: string; createdAt?: string; updatedAt?: string },
  ): Promise<WithMetadata<Record<string, unknown>>>;
  buildSet(
    def: CollectionDefinition,
    id: string,
    input: unknown,
    existing: WithMetadata<Record<string, unknown>> | null,
  ): Promise<WithMetadata<Record<string, unknown>>>;
  buildUpdate(
    def: CollectionDefinition,
    id: string,
    input: unknown,
    existing: WithMetadata<Record<string, unknown>>,
  ): Promise<WithMetadata<Record<string, unknown>>>;
}
