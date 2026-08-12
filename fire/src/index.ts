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

export { SchemaValidationError, parseSchema } from "./schema";
export type { AnySchema, InferSchemaInput, InferSchemaOutput } from "./schema";

export { ownedBy } from "./owned-by";
export type { OwnedByOptions } from "./owned-by";
export { defineResource } from "./define-resource";

export { createDurableObjectStorage, createMemoryStorage } from "./storage";
export { createTypedStorage } from "./typed-storage";
export { executeOperation } from "./executor";

export type {
  AccessAction,
  AccessContext,
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
  ResourceOperation,
  ResourcesDef,
  StorageDriver,
  ValidationIssue,
  WithId,
  WithMetadata,
} from "./types";
