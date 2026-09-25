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
} from "./context/types";
export type { ActionDefinition, ActionDefinitions, ScopedActions } from "./action";
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
  ListAllLimitError,
  BadRequestError,
  TakibiError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "@takibi/api";

export {
  and,
  constrainedPolicyBrand,
  contextPolicyBrand,
  fullAccess,
  grant,
  none,
  or,
  read,
  write,
} from "./policy";
export type { ConstrainedPolicy, ContextPolicy, InferPolicyDoc } from "./policy";
export { listWhere, queryImpliesEquality } from "./query";

export type {
  AccessPermission,
  AccessContext,
  AccessGrant,
  AccessPolicy,
  AccessPolicyFn,
  PolicyReasonCodeCarrier,
  PolicyReasonCodeOf,
  ClientCollectionApi,
  CollectionDataInput,
  CollectionApi,
  NarrowCollectionDoc,
  CollectionsApi,
  DurableObjectCollectionsApi,
  TrustedCollectionApi,
  TrustedCollectionsApi,
  SnapshotRestoreReport,
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

export type { ListWhereScope } from "@takibi/shared-types";
