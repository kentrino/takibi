export { createClient } from "./client";
export type {
  ClientOf,
  CreateClientOptions,
  InferHandlerActions,
  InferHandlerCollections,
} from "./client";

export { createTakibi } from "./context";
export type {
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  CollectionsOptions,
  TakibiHandler,
  HandleOptions,
  HandleResult,
} from "./context";

export {
  BadRequestError,
  ConflictError,
  TakibiError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./errors";

export { SchemaValidationError } from "./schema";

export { allows, and, fullAccess, grant, none, or, read, write } from "./policy";
export { queryImpliesEquality } from "./query";

export type {
  AccessPermission,
  AccessContext,
  AccessGrant,
  AccessPolicy,
  AccessPolicyFn,
  ClientCollectionApi,
  CollectionDataInput,
  CollectionDefinition,
  CollectionOperation,
  CollectionApi,
  CollectionsApi,
  CollectionsDef,
  DocumentId,
  DocumentMetadata,
  TakibiFailure,
  TakibiOperationFailure,
  TakibiResult,
  TakibiValidationFailure,
  InferCollectionDoc,
  InferCollectionInput,
  JsonValue,
  ListOptions,
  QueryBuilder,
  QueryExpr,
  QueryField,
  QueryOperator,
  QueryScalar,
  ValidationIssue,
  WithId,
  WithMetadata,
} from "./types";
