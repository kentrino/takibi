import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AccessGrant } from "./permissions";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type DocumentId = string;

export type WithId<T> = T & { id: DocumentId };

export type ResourceOperation = "add" | "set" | "get" | "update" | "delete" | "list";

export type AccessContext<TCtx> = TCtx & {
  tenantId: string;
  user: unknown;
  resource: string;
  operation: ResourceOperation;
};

export type ResourceDefinition<
  TSchema extends StandardSchemaV1 = StandardSchemaV1,
  // Default `any` keeps resource maps assignable regardless of concrete context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional for assignability
  TCtx = any,
> = {
  schema: TSchema;
  accessControl: (ctx: AccessContext<TCtx>) => AccessGrant | Promise<AccessGrant>;
};

export type ResourcesDef<TCtx = any> = {
  [key: string]: ResourceDefinition<StandardSchemaV1, TCtx>;
};

export type InferResourceDoc<R> = R extends { schema: infer S extends StandardSchemaV1 }
  ? WithId<StandardSchemaV1.InferOutput<S>>
  : never;

export type InferResourceInput<R> = R extends { schema: infer S extends StandardSchemaV1 }
  ? StandardSchemaV1.InferInput<S>
  : never;

export type CollectionApi<R> = {
  add: (data: Omit<InferResourceInput<R>, "id"> & { id?: string }) => Promise<InferResourceDoc<R>>;
  set: (id: string, data: InferResourceInput<R>) => Promise<InferResourceDoc<R>>;
  get: (id: string) => Promise<InferResourceDoc<R> | null>;
  update: (id: string, data: Partial<InferResourceInput<R>>) => Promise<InferResourceDoc<R>>;
  delete: (id: string) => Promise<{ id: string }>;
  list: (opts?: { limit?: number; cursor?: string }) => Promise<{
    items: InferResourceDoc<R>[];
    nextCursor?: string;
  }>;
};

export type ClientOf<TResources> = {
  [K in keyof TResources]: CollectionApi<TResources[K]>;
};

export type ListOptions = {
  limit?: number;
  cursor?: string;
};

export type StorageDriver = {
  get(resource: string, id: string): Promise<WithId<Record<string, unknown>> | null>;
  put(resource: string, doc: WithId<Record<string, unknown>>): Promise<void>;
  delete(resource: string, id: string): Promise<boolean>;
  list(
    resource: string,
    opts?: ListOptions,
  ): Promise<{ items: WithId<Record<string, unknown>>[]; nextCursor?: string }>;
};
