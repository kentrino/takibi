export { createClient } from "./client";
export type {
  ClientOf,
  CreateClientOptions,
  InferHandlerActions,
  InferHandlerCollections,
} from "./client";

export {
  AlreadyExistsError,
  StaleWriteError,
  BadRequestError,
  TakibiError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./errors";

export type { TakibiResult } from "./types";
