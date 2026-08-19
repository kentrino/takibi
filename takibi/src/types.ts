import type { StandardSchemaV1 } from "@standard-schema/spec";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

type JsonDocumentSchema<TSchema extends StandardSchemaV1> =
  IsAny<TSchema> extends true
    ? TSchema
    : IsAny<StandardSchemaV1.InferOutput<TSchema>> extends true
      ? TSchema
      : unknown extends StandardSchemaV1.InferOutput<TSchema>
        ? TSchema
        : StandardSchemaV1.InferOutput<TSchema> extends JsonObject
          ? TSchema
          : never;

export type DocumentId = string;
export const TAKIBI_VERSION_KEY = "_takibiVersion" as const;

export type DocumentMetadata = {
  id: DocumentId;
  createdAt: string;
  updatedAt: string;
};

export type WithId<T> = Omit<T, "id"> & { id: DocumentId };

export type WithMetadata<T> = Omit<T, keyof DocumentMetadata | typeof TAKIBI_VERSION_KEY> &
  DocumentMetadata;

/** @internal Persisted representation. The version marker never crosses the storage boundary. */
export type StoredDocument = WithMetadata<Record<string, unknown>> & {
  [TAKIBI_VERSION_KEY]?: unknown;
};

export type MigrationStep<TOutput = unknown> = (data: unknown) => TOutput;

export type MigrationSteps<TCurrentInput> =
  | readonly []
  | readonly [...MigrationStep[], MigrationStep<TCurrentInput>];

export type CollectionMigrations<TCurrentInput> = {
  /** Oldest version accepted by this registry. Defaults to 0. */
  base?: number;
  /** Ordered, append-only transforms from `base` to the current schema version. */
  steps: MigrationSteps<TCurrentInput>;
};

export type QueryScalar = string | number | boolean | null;

export type QueryOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export type QueryExpr =
  | { readonly field: string; readonly op: QueryOperator; readonly value: QueryScalar }
  | { readonly op: "and" | "or"; readonly operands: readonly QueryExpr[] }
  | { readonly op: "not"; readonly operand: QueryExpr };

type QueryEqValue<T> = Extract<Exclude<T, undefined>, QueryScalar>;
type QueryComparableValue<T> = Extract<Exclude<T, undefined | null>, string | number>;

export type QueryField<T> = ([QueryEqValue<T>] extends [never]
  ? object
  : { eq(value: QueryEqValue<T>): QueryExpr }) &
  ([QueryComparableValue<T>] extends [never]
    ? object
    : {
        gt(value: QueryComparableValue<T>): QueryExpr;
        gte(value: QueryComparableValue<T>): QueryExpr;
        lt(value: QueryComparableValue<T>): QueryExpr;
        lte(value: QueryComparableValue<T>): QueryExpr;
      });

type QueryFields<TDoc> = {
  [K in keyof TDoc as K extends string ? K : never]-?: QueryField<TDoc[K]>;
};

export type QueryBuilder<TDoc> = QueryFields<TDoc> & {
  and(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  or(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  not(operand: QueryExpr): QueryExpr;
};

export type CollectionOperation = "add" | "set" | "get" | "update" | "delete" | "list";

export type AccessPermission = "create" | "get" | "list" | "update" | "delete" | "invoke";

declare const accessGrantBrand: unique symbol;

/** Opaque grant a policy returns. Build with `grant(...)` or a predefined grant. */
export type AccessGrant = {
  readonly [accessGrantBrand]: true;
};

export type AccessContext<
  TCtx extends object,
  TDoc = WithMetadata<Record<string, unknown>>,
> = TCtx & {
  collection: string;
  operation: "add" | "set" | "get" | "update" | "delete" | "list";
  permission: Exclude<AccessPermission, "invoke">;
  /** Normalized list query. Present only when list was called with `where`. */
  where?: QueryExpr;
  /** Saved document for get / update / delete / existing set. Absent for add / list / new set. */
  doc?: TDoc;
  /** Validated write candidate for add / update / set. Absent for get / delete / list. */
  nextDoc?: TDoc;
};

/**
 * Capability producer: return the actions this subject may perform on this
 * collection / document. Prefer not switching on `permission` — the executor
 * collates the grant against the required permission.
 */
export type AccessPolicyFn<TCtx extends object, TDoc = WithMetadata<Record<string, unknown>>> = (
  ctx: AccessContext<TCtx, TDoc>,
) => AccessGrant | Promise<AccessGrant>;

/**
 * `accessPolicy` value: a function, or a constant grant
 * (`fullAccess`, `write`, `read`, `none`).
 */
export type AccessPolicy<TCtx extends object, TDoc = WithMetadata<Record<string, unknown>>> =
  | AccessGrant
  | AccessPolicyFn<TCtx, TDoc>;

export const collectionActionsBrand: unique symbol = Symbol("fire.collectionActions");

export type CollectionDefinition<
  TSchema extends StandardSchemaV1 = any,
  // Default `any` keeps collection maps assignable regardless of concrete context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional for assignability
  TCtx extends object = any,
  TActions = unknown,
> = {
  schema: JsonDocumentSchema<TSchema>;
  accessPolicy: AccessPolicy<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>>;
  migrations?: CollectionMigrations<StandardSchemaV1.InferInput<TSchema>>;
  /**
   * Initial documents keyed by document ID. Seeds are create-only: existing
   * documents are never overwritten when a Durable Object is reactivated.
   */
  seed?: () =>
    | Readonly<
        Record<
          DocumentId,
          Omit<
            StandardSchemaV1.InferInput<TSchema>,
            keyof DocumentMetadata | typeof TAKIBI_VERSION_KEY
          >
        >
      >
    | Promise<
        Readonly<
          Record<
            DocumentId,
            Omit<
              StandardSchemaV1.InferInput<TSchema>,
              keyof DocumentMetadata | typeof TAKIBI_VERSION_KEY
            >
          >
        >
      >;
  /** @internal Carries collection action definitions for assembly and inference. */
  readonly [collectionActionsBrand]?: TActions;
};

export type CollectionsDef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous collection map
  TCtx extends object = any,
> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous collection map
  [key: string]: CollectionDefinition<any, TCtx, any>;
};

export type InferCollectionDoc<C> = C extends { schema: infer S extends StandardSchemaV1 }
  ? WithMetadata<StandardSchemaV1.InferOutput<S>>
  : never;

export type InferCollectionInput<C> = C extends { schema: infer S extends StandardSchemaV1 }
  ? StandardSchemaV1.InferInput<S>
  : never;

export type CollectionDataInput<C> = Omit<
  InferCollectionInput<C>,
  keyof DocumentMetadata | typeof TAKIBI_VERSION_KEY
>;

export type ValidationIssue = {
  message: string;
  path?: readonly (string | number)[];
};

export type TakibiValidationFailure = {
  kind: "validation";
  code: "VALIDATION";
  message: string;
  status: 400;
  issues: readonly ValidationIssue[];
};

export type TakibiOperationFailure = {
  kind: "operation";
  code: string;
  message: string;
  status: number;
};

export type TakibiFailure = TakibiValidationFailure | TakibiOperationFailure;

export type TakibiResult<T> = { ok: true; data: T } | { ok: false; error: TakibiFailure };

/** Throwing, server-side CRUD facade used by actions and trusted `$collections`. */
export type CollectionApi<C> = {
  add: (
    data: CollectionDataInput<C>,
    options?: { id?: DocumentId },
  ) => Promise<InferCollectionDoc<C>>;
  set: (id: DocumentId, data: CollectionDataInput<C>) => Promise<InferCollectionDoc<C>>;
  get: (id: DocumentId) => Promise<InferCollectionDoc<C>>;
  update: (id: DocumentId, data: Partial<CollectionDataInput<C>>) => Promise<InferCollectionDoc<C>>;
  delete: (id: DocumentId) => Promise<{ id: DocumentId }>;
  list: (opts?: ListOptions<InferCollectionDoc<C>>) => Promise<{
    items: InferCollectionDoc<C>[];
    nextCursor?: string;
  }>;
};

export type CollectionsApi<TCollections> = {
  [K in keyof TCollections]: CollectionApi<TCollections[K]>;
};

/** Result-shaped CRUD facade used by the public HTTP client. */
export type ClientCollectionApi<C> = {
  add: (
    data: CollectionDataInput<C>,
    options?: { id?: DocumentId },
  ) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  set: (
    id: DocumentId,
    data: CollectionDataInput<C>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  get: (id: DocumentId) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  update: (
    id: DocumentId,
    data: Partial<CollectionDataInput<C>>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  delete: (id: DocumentId) => Promise<TakibiResult<{ id: DocumentId }>>;
  list: (opts?: ListOptions<InferCollectionDoc<C>>) => Promise<
    TakibiResult<{
      items: InferCollectionDoc<C>[];
      nextCursor?: string;
    }>
  >;
};

export type ClientCollectionsApi<TCollections> = {
  [K in keyof TCollections]: ClientCollectionApi<TCollections[K]>;
};

export type ListOptions<TDoc = WithMetadata<Record<string, QueryScalar>>> = {
  limit?: number;
  cursor?: string;
  where?: (query: QueryBuilder<TDoc>) => QueryExpr;
};

export type StorageListOptions = {
  limit?: number;
  cursor?: string;
  where?: QueryExpr;
};

export type StorageReadTransform = (
  document: StoredDocument,
) => Promise<WithMetadata<Record<string, unknown>>>;

export type StorageListPlan = {
  currentVersion: number;
  transform: StorageReadTransform;
};

export type StorageDriver = {
  get(resource: string, id: string): Promise<StoredDocument | null>;
  put(resource: string, doc: StoredDocument): Promise<void>;
  delete(resource: string, id: string): Promise<boolean>;
  list(
    resource: string,
    opts?: StorageListOptions,
    plan?: StorageListPlan,
  ): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }>;
  transaction<T>(callback: (storage: StorageDriver) => Promise<T>): Promise<T>;
};
