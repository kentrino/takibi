export class FireError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "FireError";
    this.code = code;
    this.status = status;
  }
}

export class UnauthorizedError extends FireError {
  constructor(message = "Unauthorized") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends FireError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends FireError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends FireError {
  constructor(message: string) {
    super("BAD_REQUEST", message, 400);
    this.name = "BadRequestError";
  }
}
