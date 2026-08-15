export { createClient } from "./client";
export type {
  ClientOf,
  CreateClientOptions,
  InferHandlerActions,
  InferHandlerCollections,
} from "./client";

export { fire, initialContext } from "./context";
export type {
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  CollectionsOptions,
  FireHandler,
  HandleOptions,
  HandleResult,
} from "./context";

export type { ActionGateContext, ActionGatePolicy } from "./action";

export {
  BadRequestError,
  ConflictError,
  FireError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./errors";

export { SchemaValidationError } from "./schema";
export type { AnySchema, InferSchemaInput, InferSchemaOutput } from "./schema";

export { allows, and, grant, none, or, read, write } from "./policy";
export type { ConstrainedPolicy, ContextPolicy, InferPolicyDoc, PolicyHelper } from "./policy";

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
  FireFailure,
  FireOperationFailure,
  FireResult,
  FireValidationFailure,
  InferCollectionDoc,
  InferCollectionInput,
  JsonValue,
  ListOptions,
  ValidationIssue,
  WithId,
  WithMetadata,
} from "./types";
