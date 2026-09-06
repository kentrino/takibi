import type { StorageListOptions, WithMetadata } from "@takibi/takibi-shared-types";
import { TAKIBI_VERSION_KEY } from "@takibi/takibi-shared-types";

export type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  AccessPolicy,
  AccessPolicyFn,
  CollectionOperation,
  PolicyReasonCodeCarrier,
  PolicyReasonCodeOf,
} from "@takibi/takibi-policy";
export type { ListOptions } from "@takibi/takibi-query";
export type {
  DocumentId,
  DocumentMetadata,
  JsonObject,
  JsonValue,
  OrderBuilder,
  OrderDirection,
  OrderExpr,
  PolicyReason,
  QueryBuilder,
  QueryExpr,
  QueryField,
  QueryOperator,
  QueryScalar,
  QueryStringOperator,
  QueryValueOperator,
  ReservedDocumentDataKey,
  SnapshotRestoreReport,
  StorageListOptions,
  StorageOrderBy,
  TakibiFailure,
  TakibiOperationFailure,
  TakibiResult,
  TakibiValidationFailure,
  ValidationIssue,
  WithId,
  WithMetadata,
} from "@takibi/takibi-shared-types";
export {
  RESERVED_DOCUMENT_DATA_KEYS,
  TAKIBI_REVISION_KEY,
  TAKIBI_VERSION_KEY,
} from "@takibi/takibi-shared-types";
export type {
  ClientCollectionApi,
  ClientCollectionsApi,
  CollectionApi,
  CollectionDataInput,
  CollectionDefinition,
  CollectionIncrementInput,
  CollectionIndexes,
  CollectionMigrations,
  CollectionPatchInput,
  CollectionUniqueConstraints,
  CollectionWriteInput,
  CollectionsApi,
  CollectionsDef,
  ConditionalWriteOptions,
  CountOptions,
  DurableObjectCollectionsApi,
  IndexDeclaration,
  IndexableFieldKeys,
  InferCollectionDoc,
  InferCollectionIndexes,
  InferCollectionInput,
  ListAllOptions,
  MigrationStep,
  MigrationSteps,
  NarrowCollectionDoc,
  ReservedDocumentSchemaConstraint,
  TakibiDefinition,
  TrustedCollectionApi,
  TrustedCollectionsApi,
  UniqueConstraintDeclaration,
} from "@takibi/takibi-api";
export { INDEXABLE_METADATA_FIELDS } from "@takibi/takibi-api";

/** @internal Persisted representation. The version marker never crosses the storage boundary. */
export type StoredDocument = WithMetadata<Record<string, unknown>> & {
  [TAKIBI_VERSION_KEY]?: unknown;
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
