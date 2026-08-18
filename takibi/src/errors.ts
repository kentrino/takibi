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

export class ForbiddenError extends TakibiError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
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

export class ConflictError extends TakibiError {
  constructor(message = "Already exists") {
    super("ALREADY_EXISTS", message, 409);
    this.name = "ConflictError";
  }
}
