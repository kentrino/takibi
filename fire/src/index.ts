export { createClient } from "./client";
export type { CreateClientOptions, InferHandlerResources } from "./client";

export { createContext } from "./context";
export type { AuthBits, ContextConfig, FireHandler, ResourcesOptions } from "./context";

export { ALL, CREATE, DELETE, EDIT, READ, UPDATE, allows, expandPermissions } from "./permissions";
export type { AccessGrant, Permission } from "./permissions";

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

export { createDurableObjectStorage, createMemoryStorage } from "./storage";
export { createTypedStorage } from "./typed-storage";
export { executeOperation } from "./executor";

export type {
  AccessContext,
  ClientOf,
  CollectionApi,
  DocumentId,
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
} from "./types";
