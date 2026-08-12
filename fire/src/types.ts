import type { StandardSchemaV1 } from "@standard-schema/spec";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type DocumentId = string;

export type DocumentMetadata = {
  id: DocumentId;
  createdAt: string;
  updatedAt: string;
};

export type WithId<T> = Omit<T, "id"> & { id: DocumentId };

export type WithMetadata<T> = Omit<T, keyof DocumentMetadata> & DocumentMetadata;

export type ResourceOperation = "add" | "set" | "get" | "update" | "delete" | "list";

export type AccessAction = "create" | "get" | "list" | "update" | "delete";

export type AccessContext<TCtx, TDoc = WithMetadata<Record<string, unknown>>> = TCtx & {
  tenantId: string;
  user: unknown;
  resource: string;
  operation: ResourceOperation;
  action: AccessAction;
  /** Saved document for get / update / delete / existing set. Absent for add / list / new set. */
  doc?: TDoc;
  /** Validated write candidate for add / update / set. Absent for get / delete / list. */
  nextDoc?: TDoc;
};

export type ResourceDefinition<
  TSchema extends StandardSchemaV1 = StandardSchemaV1,
  // Default `any` keeps resource maps assignable regardless of concrete context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional for assignability
  TCtx = any,
> = {
  schema: TSchema;
  accessPolicy: (
    ctx: AccessContext<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>>,
  ) => boolean | Promise<boolean>;
  /**
   * Initial documents keyed by document ID. Seeds are create-only: existing
   * documents are never overwritten when a Durable Object is reactivated.
   */
  seed?: () =>
    | Readonly<
        Record<DocumentId, Omit<StandardSchemaV1.InferInput<TSchema>, keyof DocumentMetadata>>
      >
    | Promise<
        Readonly<
          Record<DocumentId, Omit<StandardSchemaV1.InferInput<TSchema>, keyof DocumentMetadata>>
        >
      >;
};

export type ResourcesDef<TCtx = any> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- concrete schemas live on each entry
  [key: string]: ResourceDefinition<any, TCtx>;
};

export type InferResourceDoc<R> = R extends { schema: infer S extends StandardSchemaV1 }
  ? WithMetadata<StandardSchemaV1.InferOutput<S>>
  : never;

export type InferResourceInput<R> = R extends { schema: infer S extends StandardSchemaV1 }
  ? StandardSchemaV1.InferInput<S>
  : never;

export type ResourceDataInput<R> = Omit<InferResourceInput<R>, keyof DocumentMetadata>;

export type ValidationIssue = {
  message: string;
  path?: readonly (string | number)[];
};

export type FireValidationFailure = {
  kind: "validation";
  code: "VALIDATION";
  message: string;
  status: 400;
  issues: readonly ValidationIssue[];
};

export type FireOperationFailure = {
  kind: "operation";
  code: string;
  message: string;
  status: number;
};

export type FireFailure = FireValidationFailure | FireOperationFailure;

export type FireResult<T> = { ok: true; data: T } | { ok: false; error: FireFailure };

export type CollectionApi<R> = {
  add: (
    data: ResourceDataInput<R>,
    options?: { id?: DocumentId },
  ) => Promise<FireResult<InferResourceDoc<R>>>;
  set: (id: DocumentId, data: ResourceDataInput<R>) => Promise<FireResult<InferResourceDoc<R>>>;
  get: (id: DocumentId) => Promise<FireResult<InferResourceDoc<R>>>;
  update: (
    id: DocumentId,
    data: Partial<ResourceDataInput<R>>,
  ) => Promise<FireResult<InferResourceDoc<R>>>;
  delete: (id: DocumentId) => Promise<FireResult<{ id: DocumentId }>>;
  list: (opts?: { limit?: number; cursor?: string }) => Promise<
    FireResult<{
      items: InferResourceDoc<R>[];
      nextCursor?: string;
    }>
  >;
};

export type ClientOf<TResources> = {
  [K in keyof TResources]: CollectionApi<TResources[K]>;
};

export type ListOptions = {
  limit?: number;
  cursor?: string;
};

export type StorageDriver = {
  get(resource: string, id: string): Promise<WithMetadata<Record<string, unknown>> | null>;
  put(resource: string, doc: WithMetadata<Record<string, unknown>>): Promise<void>;
  delete(resource: string, id: string): Promise<boolean>;
  list(
    resource: string,
    opts?: ListOptions,
  ): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }>;
};
