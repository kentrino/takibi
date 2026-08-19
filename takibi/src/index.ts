export { createClient } from "./client";
export type {
  ClientOf,
  CreateClientOptions,
  InferHandlerActions,
  InferHandlerCollections,
} from "./client";

export { createTakibi } from "./context";
export type { CollectionsOptions, TakibiHandler, HandleOptions, HandleResult } from "./context";

export {
  AlreadyExistsError,
  BadRequestError,
  TakibiError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./errors";

export { and, fullAccess, grant, none, or, read, write } from "./policy";
export { queryImpliesEquality } from "./query";

export type {
  AccessPermission,
  AccessContext,
  AccessGrant,
  AccessPolicy,
  AccessPolicyFn,
  ClientCollectionApi,
  CollectionDataInput,
  CollectionApi,
  CollectionsApi,
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
