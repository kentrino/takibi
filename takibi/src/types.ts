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
export const TAKIBI_VERSION_KEY = "$schemaVersion" as const;
export const TAKIBI_REVISION_KEY = "rev" as const;

export type DocumentMetadata = {
  id: DocumentId;
  createdAt: string;
  updatedAt: string;
};

export type ReservedDocumentDataKey =
  | keyof DocumentMetadata
  | typeof TAKIBI_VERSION_KEY
  | typeof TAKIBI_REVISION_KEY;

export const RESERVED_DOCUMENT_DATA_KEYS = [
  "id",
  "createdAt",
  "updatedAt",
  TAKIBI_VERSION_KEY,
  TAKIBI_REVISION_KEY,
] as const satisfies readonly ReservedDocumentDataKey[];

type KnownObjectKeys<T> = {
  [K in keyof T]-?: string extends K ? never : number extends K ? never : K;
}[keyof T];

type DeclaresReservedDocumentKey<T> =
  Extract<KnownObjectKeys<T>, ReservedDocumentDataKey> extends never ? false : true;

/** @internal Rejects collection schemas that declare reserved document keys. */
export type ReservedDocumentSchemaConstraint<TSchema extends StandardSchemaV1> =
  IsAny<TSchema> extends true
    ? unknown
    : unknown extends StandardSchemaV1.InferOutput<TSchema>
      ? unknown
      : DeclaresReservedDocumentKey<StandardSchemaV1.InferOutput<TSchema>> extends true
        ? { schema: never }
        : unknown extends StandardSchemaV1.InferInput<TSchema>
          ? unknown
          : DeclaresReservedDocumentKey<StandardSchemaV1.InferInput<TSchema>> extends true
            ? { schema: never }
            : unknown;

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
  [K in keyof TDoc as K extends string
    ? K extends typeof TAKIBI_REVISION_KEY | typeof TAKIBI_VERSION_KEY
      ? never
      : K
    : never]-?: QueryField<TDoc[K]>;
};

export type QueryBuilder<TDoc> = QueryFields<TDoc> & {
  and(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  or(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  not(operand: QueryExpr): QueryExpr;
};

export type CollectionOperation = "add" | "set" | "get" | "update" | "delete" | "list";

export type AccessPermission = "create" | "get" | "list" | "update" | "delete" | "invoke";

declare const accessGrantBrand: unique symbol;
declare const policyReasonCodeBrand: unique symbol;

export type PolicyReason<TCode extends string = string> = {
  /**
   * Stable, machine-readable identifier for a public policy denial reason.
   * Clients should branch on this value and map it to localized UI copy.
   */
  readonly code: TCode;
  /**
   * Optional, non-localized developer description. This value is serialized
   * to clients, so it must be static and must not contain sensitive data.
   */
  readonly description?: string;
};

/** @internal Type-only carrier used to preserve policy reason literals. */
export type PolicyReasonCodeCarrier<TCode extends string> = {
  readonly [policyReasonCodeBrand]: TCode;
};

/** Extract the policy reason code union carried by a policy definition. */
export type PolicyReasonCodeOf<T> =
  T extends PolicyReasonCodeCarrier<infer TCode extends string> ? TCode : never;

/** Opaque grant a policy returns. Build with `grant(...)` or a predefined grant. */
export type AccessGrant = {
  readonly [accessGrantBrand]: true;
};

export type AccessContext<
  TCtx extends object,
  TDoc = WithMetadata<Record<string, unknown>>,
> = TCtx & {
  collection: string;
  operation: "add" | "set" | "get" | "update" | "delete" | "list" | "invoke";
  permission: AccessPermission;
  /** Normalized list query. Present only when list was called with `where`. */
  where?: QueryExpr;
  /**
   * Saved document for get / update / delete / existing set, and the target
   * document for a document action gate (`invoke`). Absent for add / list /
   * new set.
   */
  doc?: TDoc;
  /** Validated write candidate for add / update / set. Absent for get / delete / list / invoke. */
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

export type CollectionDefinition<
  TSchema extends StandardSchemaV1 = any,
  // Default `any` keeps collection maps assignable regardless of concrete context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional for assignability
  TCtx extends object = any,
  TPolicy extends AccessPolicy<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>> =
    AccessPolicy<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>>,
> = {
  schema: JsonDocumentSchema<TSchema>;
  accessPolicy: TPolicy;
  migrations?: CollectionMigrations<StandardSchemaV1.InferInput<TSchema>>;
  /**
   * Initial documents keyed by document ID. Seeds are create-only: existing
   * documents are never overwritten when a Durable Object is reactivated.
   */
  seed?: () =>
    | Readonly<
        Record<DocumentId, Omit<StandardSchemaV1.InferInput<TSchema>, ReservedDocumentDataKey>>
      >
    | Promise<
        Readonly<
          Record<DocumentId, Omit<StandardSchemaV1.InferInput<TSchema>, ReservedDocumentDataKey>>
        >
      >;
};

export type CollectionsDef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous collection map
  TCtx extends object = any,
> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous collection map
  [key: string]: CollectionDefinition<any, TCtx>;
};

export type InferCollectionDoc<C> = C extends { schema: infer S extends StandardSchemaV1 }
  ? WithMetadata<StandardSchemaV1.InferOutput<S>> & { [TAKIBI_REVISION_KEY]: number }
  : never;

export type InferCollectionInput<C> = C extends { schema: infer S extends StandardSchemaV1 }
  ? StandardSchemaV1.InferInput<S>
  : never;

export type CollectionDataInput<C> = Omit<InferCollectionInput<C>, ReservedDocumentDataKey>;

export type CollectionWriteInput<C> = CollectionDataInput<C> & {
  [TAKIBI_REVISION_KEY]?: number;
};

export type CollectionPatchInput<C> = Partial<CollectionDataInput<C>> & {
  [TAKIBI_REVISION_KEY]?: number;
};

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

type TakibiOperationFailureBase = {
  kind: "operation";
  code: string;
  message: string;
  status: number;
};

export type TakibiOperationFailure<TReasonCode extends string = never> =
  TakibiOperationFailureBase &
    ([TReasonCode] extends [never] ? object : { reason?: PolicyReason<TReasonCode> });

export type TakibiFailure<TReasonCode extends string = never> =
  | TakibiValidationFailure
  | TakibiOperationFailure<TReasonCode>;

export type TakibiResult<T, TReasonCode extends string = never> =
  | { ok: true; data: T }
  | { ok: false; error: TakibiFailure<TReasonCode> };

/** Throwing, server-side CRUD facade used by actions and trusted `$collections`. */
export type CollectionApi<C> = {
  add: (
    data: CollectionDataInput<C>,
    options?: { id?: DocumentId },
  ) => Promise<InferCollectionDoc<C>>;
  set: (id: DocumentId, data: CollectionWriteInput<C>) => Promise<InferCollectionDoc<C>>;
  get: (id: DocumentId) => Promise<InferCollectionDoc<C>>;
  update: (id: DocumentId, data: CollectionPatchInput<C>) => Promise<InferCollectionDoc<C>>;
  delete: (id: DocumentId) => Promise<{ id: DocumentId }>;
  list: (opts?: ListOptions<InferCollectionDoc<C>>) => Promise<{
    items: InferCollectionDoc<C>[];
    nextCursor?: string;
  }>;
  listAll: (opts?: ListAllOptions<InferCollectionDoc<C>>) => Promise<InferCollectionDoc<C>[]>;
};

export type CollectionsApi<TCollections> = {
  [K in keyof TCollections]: CollectionApi<TCollections[K]>;
};

/** Result-shaped CRUD facade used by the public HTTP client. */
type CollectionPolicyReasonCode<C> = C extends { accessPolicy: infer TPolicy }
  ? PolicyReasonCodeOf<TPolicy>
  : never;

export type ClientCollectionApi<C> = {
  add: (
    data: CollectionDataInput<C>,
    options?: { id?: DocumentId },
  ) => Promise<TakibiResult<InferCollectionDoc<C>, CollectionPolicyReasonCode<C>>>;
  set: (
    id: DocumentId,
    data: CollectionWriteInput<C>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  get: (id: DocumentId) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  update: (
    id: DocumentId,
    data: CollectionPatchInput<C>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  delete: (id: DocumentId) => Promise<TakibiResult<{ id: DocumentId }>>;
  list: (opts?: ListOptions<InferCollectionDoc<C>>) => Promise<
    TakibiResult<
      {
        items: InferCollectionDoc<C>[];
        nextCursor?: string;
      },
      CollectionPolicyReasonCode<C>
    >
  >;
  listAll: (
    opts?: ListAllOptions<InferCollectionDoc<C>>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>[], CollectionPolicyReasonCode<C>>>;
};

export type ClientCollectionsApi<TCollections> = {
  [K in keyof TCollections]: ClientCollectionApi<TCollections[K]>;
};

export type ListOptions<TDoc = WithMetadata<Record<string, QueryScalar>>> = {
  limit?: number;
  cursor?: string;
  where?: (query: QueryBuilder<TDoc>) => QueryExpr;
};

/** Client / server convenience over repeated `list` pages. Not a policy permission. */
export type ListAllOptions<TDoc = WithMetadata<Record<string, QueryScalar>>> = {
  where?: ListOptions<TDoc>["where"];
  /** Page size forwarded to `list`. Defaults to the per-request maximum (200). */
  pageSize?: number;
  /**
   * Safety cap across all pages. If matching documents remain after this many
   * items, `listAll` fails with `LIST_ALL_LIMIT` instead of truncating.
   */
  maxItems?: number;
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
