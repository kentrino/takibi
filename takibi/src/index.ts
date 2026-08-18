export { createClient } from "./client";
export type {
  ClientOf,
  CreateClientOptions,
  InferHandlerActions,
  InferHandlerCollections,
} from "./client";

export { createTakibi } from "./context";
export type {
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
  CollectionApi,
  CollectionsApi,
  CollectionsDef,
  TakibiResult,
  InferCollectionDoc,
  InferCollectionInput,
  JsonValue,
  QueryBuilder,
  QueryExpr,
  QueryField,
  QueryOperator,
  QueryScalar,
} from "./types";
