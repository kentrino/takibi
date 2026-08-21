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
} from "./context-types";
export { createPrettyConsoleLogger } from "./logging";
export type {
  Logger,
  LogEvent,
  LogLevel,
  LoggingOptions,
  PrettyConsoleLoggerOptions,
} from "./logging";

export {
  AlreadyExistsError,
  StaleWriteError,
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
  PolicyReason,
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
