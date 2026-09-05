export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type QueryScalar = string | number | boolean | null;

export type QueryValueOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export type QueryStringOperator = "contains" | "startsWith" | "endsWith";

export type QueryOperator = QueryValueOperator | QueryStringOperator | "in" | "present";

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
    ? K extends "$schemaVersion" | "rev"
      ? never
      : K
    : never]-?: QueryField<TDoc[K]>;
};

export type QueryBuilder<TDoc> = QueryFields<TDoc> & {
  and(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  or(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  not(operand: QueryExpr): QueryExpr;
};

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

export type WithId<T> = Omit<T, "id"> & { id: DocumentId };

export type WithMetadata<T> = Omit<T, keyof DocumentMetadata | typeof TAKIBI_VERSION_KEY> &
  DocumentMetadata;

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
