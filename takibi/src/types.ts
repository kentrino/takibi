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

export type QueryValueOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export type QueryStringOperator = "contains" | "startsWith" | "endsWith";

export type QueryOperator = QueryValueOperator | QueryStringOperator | "in" | "present";

type UniqueFieldKeys<TSchema extends StandardSchemaV1> = {
  [K in keyof StandardSchemaV1.InferOutput<TSchema> & string]-?: IsAny<
    StandardSchemaV1.InferOutput<TSchema>[K]
  > extends true
    ? never
    : unknown extends StandardSchemaV1.InferOutput<TSchema>[K]
      ? never
      : Exclude<StandardSchemaV1.InferOutput<TSchema>[K], null | undefined> extends Exclude<
            QueryScalar,
            null
          >
        ? [Exclude<StandardSchemaV1.InferOutput<TSchema>[K], null | undefined>] extends [never]
          ? never
          : K
        : never;
}[keyof StandardSchemaV1.InferOutput<TSchema> & string];

export type CollectionUniqueConstraints<TSchema extends StandardSchemaV1> = Readonly<
  Record<string, readonly [UniqueFieldKeys<TSchema>, ...UniqueFieldKeys<TSchema>[]]>
>;

type HasDuplicateTupleMember<T extends readonly unknown[]> = T extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends Tail[number]
    ? true
    : HasDuplicateTupleMember<Tail>
  : false;

/** @internal Validates inferred literal constraint tuples without widening them. */
export type UniqueConstraintDeclaration<TSchema extends StandardSchemaV1, TUnique> =
  TUnique extends CollectionUniqueConstraints<TSchema>
    ? {
        [K in keyof TUnique]: TUnique[K] extends readonly unknown[]
          ? HasDuplicateTupleMember<TUnique[K]> extends true
            ? never
            : TUnique[K]
          : never;
      }
    : never;

export const INDEXABLE_METADATA_FIELDS = ["id", "createdAt", "updatedAt"] as const;

type RequiredIndexableDomainKeys<TSchema extends StandardSchemaV1> = {
  [K in keyof StandardSchemaV1.InferOutput<TSchema> & string]: IsAny<
    StandardSchemaV1.InferOutput<TSchema>[K]
  > extends true
    ? never
    : unknown extends StandardSchemaV1.InferOutput<TSchema>[K]
      ? never
      : undefined extends StandardSchemaV1.InferOutput<TSchema>[K]
        ? never
        : null extends StandardSchemaV1.InferOutput<TSchema>[K]
          ? never
          : [StandardSchemaV1.InferOutput<TSchema>[K]] extends [string]
            ? K
            : [StandardSchemaV1.InferOutput<TSchema>[K]] extends [number]
              ? K
              : never;
}[keyof StandardSchemaV1.InferOutput<TSchema> & string];

export type IndexableFieldKeys<TSchema extends StandardSchemaV1> =
  | RequiredIndexableDomainKeys<TSchema>
  | (typeof INDEXABLE_METADATA_FIELDS)[number];

export type CollectionIndexes<TSchema extends StandardSchemaV1> = Readonly<
  Record<string, readonly [IndexableFieldKeys<TSchema>, ...IndexableFieldKeys<TSchema>[]]>
>;

/** @internal Validates inferred literal index tuples without widening them. */
export type IndexDeclaration<TSchema extends StandardSchemaV1, TIndexes> =
  TIndexes extends CollectionIndexes<TSchema>
    ? {
        [K in keyof TIndexes]: TIndexes[K] extends readonly unknown[]
          ? HasDuplicateTupleMember<TIndexes[K]> extends true
            ? never
            : TIndexes[K]
          : never;
      }
    : never;

export type InferCollectionIndexes<C> = C extends { indexes?: infer I }
  ? [I] extends [undefined]
    ? Record<string, never>
    : NonNullable<I> extends Record<string, readonly string[]>
      ? string extends keyof NonNullable<I>
        ? Record<string, never>
        : NonNullable<I>
      : Record<string, never>
  : Record<string, never>;

export type OrderDirection = "asc" | "desc";

export type OrderExpr = {
  readonly field: string;
  readonly direction: OrderDirection;
};

export type OrderBuilder<TFields extends readonly string[]> = {
  [K in TFields[number]]: {
    asc(): OrderExpr;
    desc(): OrderExpr;
  };
};

export type QueryExpr =
  | { readonly field: string; readonly op: QueryValueOperator; readonly value: QueryScalar }
  | { readonly field: string; readonly op: "in"; readonly values: readonly QueryScalar[] }
  | {
      readonly field: string;
      readonly op: QueryStringOperator;
      readonly value: string;
    }
  | { readonly field: string; readonly op: "present" }
  | { readonly op: "and" | "or"; readonly operands: readonly QueryExpr[] }
  | { readonly op: "not"; readonly operand: QueryExpr };

type QueryEqValue<T> = Extract<Exclude<T, undefined>, QueryScalar>;
type QueryComparableValue<T> = Extract<Exclude<T, undefined | null>, string | number>;
type QueryStringValue<T> = [Exclude<T, undefined | null>] extends [never]
  ? never
  : [Exclude<T, undefined | null>] extends [string]
    ? Extract<Exclude<T, undefined | null>, string>
    : never;

export type QueryField<T> = { present(): QueryExpr } & ([QueryEqValue<T>] extends [never]
  ? object
  : {
      eq(value: QueryEqValue<T>): QueryExpr;
      in(values: readonly QueryEqValue<T>[]): QueryExpr;
    }) &
  ([QueryComparableValue<T>] extends [never]
    ? object
    : {
        gt(value: QueryComparableValue<T>): QueryExpr;
        gte(value: QueryComparableValue<T>): QueryExpr;
        lt(value: QueryComparableValue<T>): QueryExpr;
        lte(value: QueryComparableValue<T>): QueryExpr;
      }) &
  ([QueryStringValue<T>] extends [never]
    ? object
    : {
        contains(value: QueryStringValue<T>): QueryExpr;
        startsWith(value: QueryStringValue<T>): QueryExpr;
        endsWith(value: QueryStringValue<T>): QueryExpr;
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

export type CollectionOperation = "add" | "set" | "get" | "update" | "delete" | "list" | "count";

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
  operation: CollectionOperation | "invoke";
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
  TIndexes extends CollectionIndexes<TSchema> | Record<string, never> = Record<string, never>,
> = {
  schema: JsonDocumentSchema<TSchema>;
  accessPolicy: TPolicy;
  /**
   * Named top-level scalar key tuples that must be unique within this
   * collection. A tuple containing a missing or null value does not
   * participate in the constraint.
   */
  unique?: CollectionUniqueConstraints<TSchema>;
  /**
   * Named composite indexes. Field order is the public scan and result-order
   * contract for `list({ index })`.
   */
  indexes?: TIndexes extends Record<string, never> ? CollectionIndexes<TSchema> : TIndexes;
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type DistributivePartial<T> = T extends unknown ? Partial<T> : never;

export type CollectionDataInput<C> = DistributiveOmit<
  InferCollectionInput<C>,
  ReservedDocumentDataKey
>;

export type CollectionWriteInput<C> = CollectionDataInput<C> & {
  [TAKIBI_REVISION_KEY]?: number;
};

export type CollectionPatchInput<C> = DistributivePartial<CollectionDataInput<C>> & {
  [TAKIBI_REVISION_KEY]?: number;
};

type IsLiteralPrimitive<T> = [T] extends [string]
  ? [string] extends [T]
    ? false
    : true
  : [T] extends [number]
    ? [number] extends [T]
      ? false
      : true
    : [T] extends [boolean]
      ? [boolean] extends [T]
        ? false
        : true
      : false;

type DiscriminantKeys<T> = {
  [K in keyof T]-?: IsLiteralPrimitive<NonNullable<T[K]>> extends true ? K & string : never;
}[keyof T];

type SharedDiscriminantKeys<TData, D> = Extract<DiscriminantKeys<TData>, keyof D & string>;

type MatchesDiscriminants<TData, D> =
  SharedDiscriminantKeys<TData, D> extends infer K
    ? [K] extends [never]
      ? true
      : K extends string
        ? {
            [P in K]: NonNullable<TData[P & keyof TData]> extends D[P & keyof D] ? true : false;
          }[K] extends true
          ? true
          : false
        : false
    : false;

type CollectionDocMembers<C> = C extends { schema: infer S extends StandardSchemaV1 }
  ? StandardSchemaV1.InferOutput<S> extends infer O
    ? O extends unknown
      ? WithMetadata<O> & { [TAKIBI_REVISION_KEY]: number }
      : never
    : never
  : never;

type NarrowDocMembers<TDoc, TData> = TDoc extends unknown
  ? MatchesDiscriminants<TData, TDoc> extends true
    ? TDoc
    : never
  : never;

type ForbidKeys<T, K extends PropertyKey> =
  Extract<keyof T, K> extends never ? unknown : { [P in Extract<keyof T, K>]?: never };

/**
 * Document produced by `add` / `set` for the given write payload.
 *
 * Members of the collection document union are kept when every discriminant
 * key they share with `TData` is assignable. Discriminant keys are those
 * whose `TData` value is a string, number, or boolean literal; optional
 * keys are treated as their `NonNullable` literal. If no member remains,
 * the result falls back to `InferCollectionDoc<C>` so a miss stays wide
 * instead of becoming `never`.
 *
 * Narrowing assumes schema transforms only normalize within the same
 * variant. A transform that rewrites a discriminant onto another variant
 * is not reflected in this type.
 */
export type NarrowCollectionDoc<C, TData> = [
  NarrowDocMembers<CollectionDocMembers<C>, TData>,
] extends [never]
  ? InferCollectionDoc<C>
  : NarrowDocMembers<CollectionDocMembers<C>, TData>;

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
  add: <TData extends CollectionDataInput<C>>(
    data: TData & ForbidKeys<TData, ReservedDocumentDataKey>,
    options?: { id?: DocumentId },
  ) => Promise<NarrowCollectionDoc<C, TData>>;
  set: <TData extends CollectionWriteInput<C>>(
    id: DocumentId,
    data: TData & ForbidKeys<TData, Exclude<ReservedDocumentDataKey, typeof TAKIBI_REVISION_KEY>>,
  ) => Promise<NarrowCollectionDoc<C, TData>>;
  get: (id: DocumentId) => Promise<InferCollectionDoc<C>>;
  update: (id: DocumentId, data: CollectionPatchInput<C>) => Promise<InferCollectionDoc<C>>;
  delete: (id: DocumentId) => Promise<{ id: DocumentId }>;
  list: (opts?: ListOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>) => Promise<{
    items: InferCollectionDoc<C>[];
    nextCursor?: string;
  }>;
  listAll: (
    opts?: ListAllOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>,
  ) => Promise<InferCollectionDoc<C>[]>;
  count: (opts?: CountOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>) => Promise<number>;
};

export type CollectionsApi<TCollections> = {
  [K in keyof TCollections]: CollectionApi<TCollections[K]>;
};

/** Local trusted facade that can preserve metadata during controlled imports. */
export type CollectionIncrementInput<C> = C extends {
  schema: infer S extends StandardSchemaV1;
}
  ? {
      [K in keyof StandardSchemaV1.InferOutput<S> & string]?: [
        Extract<Exclude<StandardSchemaV1.InferOutput<S>[K], null | undefined>, number>,
      ] extends [never]
        ? never
        : number;
    }
  : never;

export type TrustedCollectionApi<C> = Omit<CollectionApi<C>, "add"> & {
  add: <TData extends CollectionDataInput<C>>(
    data: TData & ForbidKeys<TData, ReservedDocumentDataKey>,
    options?: {
      id?: DocumentId;
      createdAt?: string;
      updatedAt?: string;
    },
  ) => Promise<NarrowCollectionDoc<C, TData>>;
  updateMany: (
    data: CollectionPatchInput<C>,
    opts: ConditionalWriteOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>,
  ) => Promise<{ updated: number }>;
  deleteMany: (
    opts: ConditionalWriteOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>,
  ) => Promise<{ deleted: number }>;
  consumeOne: (
    opts: ConditionalWriteOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>,
  ) => Promise<InferCollectionDoc<C> | null>;
  incrementOne: (
    increment: CollectionIncrementInput<C>,
    opts: ConditionalWriteOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>> & {
      set?: CollectionPatchInput<C>;
    },
  ) => Promise<InferCollectionDoc<C> | null>;
};

export type TrustedCollectionsApi<TCollections> = {
  [K in keyof TCollections]: TrustedCollectionApi<TCollections[K]>;
};

/** Result-shaped CRUD facade used by the public HTTP client. */
type CollectionPolicyReasonCode<C> = C extends { accessPolicy: infer TPolicy }
  ? PolicyReasonCodeOf<TPolicy>
  : never;

export type ClientCollectionApi<C> = {
  add: <TData extends CollectionDataInput<C>>(
    data: TData & ForbidKeys<TData, ReservedDocumentDataKey>,
    options?: { id?: DocumentId },
  ) => Promise<TakibiResult<NarrowCollectionDoc<C, TData>, CollectionPolicyReasonCode<C>>>;
  set: <TData extends CollectionWriteInput<C>>(
    id: DocumentId,
    data: TData & ForbidKeys<TData, Exclude<ReservedDocumentDataKey, typeof TAKIBI_REVISION_KEY>>,
  ) => Promise<TakibiResult<NarrowCollectionDoc<C, TData>>>;
  get: (id: DocumentId) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  update: (
    id: DocumentId,
    data: CollectionPatchInput<C>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>>>;
  delete: (id: DocumentId) => Promise<TakibiResult<{ id: DocumentId }>>;
  list: (opts?: ListOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>) => Promise<
    TakibiResult<
      {
        items: InferCollectionDoc<C>[];
        nextCursor?: string;
      },
      CollectionPolicyReasonCode<C>
    >
  >;
  listAll: (
    opts?: ListAllOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>,
  ) => Promise<TakibiResult<InferCollectionDoc<C>[], CollectionPolicyReasonCode<C>>>;
};

export type ClientCollectionsApi<TCollections> = {
  [K in keyof TCollections]: ClientCollectionApi<TCollections[K]>;
};

type UnindexedListOptions<TDoc> = {
  limit?: number;
  cursor?: string;
  where?: (query: QueryBuilder<TDoc>) => QueryExpr;
};

type IndexedListOptions<TDoc, TIndexes extends Record<string, readonly string[]>> = {
  [K in keyof TIndexes & string]: {
    index: K;
    limit?: number;
    cursor?: string;
    where?: (query: QueryBuilder<TDoc>) => QueryExpr;
    orderBy?: (query: OrderBuilder<TIndexes[K]>) => OrderExpr;
  };
}[keyof TIndexes & string];

export type ListOptions<
  TDoc = WithMetadata<Record<string, QueryScalar>>,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
> = [keyof TIndexes] extends [never]
  ? UnindexedListOptions<TDoc>
  :
      | (UnindexedListOptions<TDoc> & { index?: never; orderBy?: never })
      | IndexedListOptions<TDoc, TIndexes>;

type ListAllFromList<T> = T extends unknown
  ? Omit<T, "limit" | "cursor"> & {
      /** Page size forwarded to `list`. Defaults to the per-request maximum (200). */
      pageSize?: number;
      /**
       * Safety cap across all pages. If matching documents remain after this many
       * items, `listAll` fails with `LIST_ALL_LIMIT` instead of truncating.
       */
      maxItems?: number;
    }
  : never;

/** Client / server convenience over repeated `list` pages. Not a policy permission. */
export type ListAllOptions<
  TDoc = WithMetadata<Record<string, QueryScalar>>,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
> = ListAllFromList<ListOptions<TDoc, TIndexes>>;

type CountFromList<T> = T extends unknown ? Omit<T, "limit" | "cursor" | "orderBy"> : never;

/** Server-only aggregate over the same query and index selection as `list`. */
export type CountOptions<
  TDoc = WithMetadata<Record<string, QueryScalar>>,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
> = CountFromList<ListOptions<TDoc, TIndexes>>;

type RequireWhere<T> = T extends unknown
  ? Omit<T, "where"> & { where: NonNullable<T extends { where?: infer W } ? W : never> }
  : never;

/** Trusted-only selector that cannot represent an unqualified write. */
export type ConditionalWriteOptions<
  TDoc = WithMetadata<Record<string, QueryScalar>>,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
> = RequireWhere<CountOptions<TDoc, TIndexes>>;

export type StorageOrderBy = {
  field: string;
  direction: OrderDirection;
};

export type StorageListOptions = {
  limit?: number;
  cursor?: string;
  where?: QueryExpr;
  index?: string;
  orderBy?: StorageOrderBy;
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
