export { createClient } from "./client";
export type { CreateClientOptions, InferHandlerResources } from "./client";

export { fire, initialContext } from "./context";
export type {
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  FireHandler,
  HandleOptions,
  HandleResult,
  ResourcesOptions,
} from "./context";

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
export type { ConstrainedPolicy, InferPolicyDoc, PolicyHelper } from "./policy";

export { ownedBy } from "./owned-by";
export type { OwnedByOptions } from "./owned-by";
export { defineResource } from "./define-resource";

export type {
  AccessAction,
  AccessContext,
  AccessGrant,
  AccessPolicy,
  AccessPolicyFn,
  ClientOf,
  CollectionApi,
  DocumentId,
  DocumentMetadata,
  FireFailure,
  FireOperationFailure,
  FireResult,
  FireValidationFailure,
  InferResourceDoc,
  InferResourceInput,
  ListOptions,
  ResourceDataInput,
  ResourceDefinition,
  ResourcesDef,
  ValidationIssue,
  WithId,
  WithMetadata,
} from "./types";
