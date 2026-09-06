import type { PolicyReason } from "@takibi/takibi-shared-types";

export class TakibiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "TakibiError";
    this.code = code;
    this.status = status;
  }
}

export class UnauthorizedError extends TakibiError {
  constructor(message = "Unauthorized") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError<TCode extends string = string> extends TakibiError {
  readonly reason?: PolicyReason<TCode>;

  constructor(message = "Forbidden", reason?: PolicyReason<TCode>) {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
    this.reason = reason;
  }
}

export class NotFoundError extends TakibiError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends TakibiError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
    this.name = "BadRequestError";
  }
}

export class AlreadyExistsError extends TakibiError {
  constructor(message = "Already exists") {
    super("ALREADY_EXISTS", message, 409);
    this.name = "AlreadyExistsError";
  }
}

export class StaleWriteError extends TakibiError {
  constructor(message = "Stale write") {
    super("STALE_WRITE", message, 409);
    this.name = "StaleWriteError";
  }
}

export class ListAllLimitError extends TakibiError {
  constructor(maxItems: number) {
    super("LIST_ALL_LIMIT", `listAll exceeded the maximum of ${maxItems} documents`, 400);
    this.name = "ListAllLimitError";
  }
}

export class MaintenanceLockedError extends TakibiError {
  constructor(message = "Takibi maintenance is in progress") {
    super("MAINTENANCE_LOCKED", message, 503);
    this.name = "MaintenanceLockedError";
  }
}

export class SnapshotFormatError extends TakibiError {
  constructor(message = "Invalid logical snapshot") {
    super("SNAPSHOT_FORMAT", message, 400);
    this.name = "SnapshotFormatError";
  }
}

export class SnapshotIncompatibleError extends TakibiError {
  constructor(message = "Logical snapshot is incompatible with this collection registry") {
    super("SNAPSHOT_INCOMPATIBLE", message, 400);
    this.name = "SnapshotIncompatibleError";
  }
}

export class SnapshotInvalidDocumentError extends TakibiError {
  constructor(message = "Logical snapshot contains an invalid document") {
    super("SNAPSHOT_INVALID_DOCUMENT", message, 400);
    this.name = "SnapshotInvalidDocumentError";
  }
}
