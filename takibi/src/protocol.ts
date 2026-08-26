import type { ActionInvocation } from "./action-executor";
import { BadRequestError } from "./errors";
import type { ExecuteRequest } from "./executor";
import { normalizeQueryExpr } from "./query";
import type { TakibiFailure } from "./types";
import type { StorageListOptions } from "./types";

type WireContext = Record<string, unknown>;

export type CollectionWireRequest = ExecuteRequest & { context: WireContext };
export type ActionWireRequest = ActionInvocation & { context: WireContext };
export type WireRequest = CollectionWireRequest | ActionWireRequest;

export type WireSuccess = { ok: true; data: unknown };
export type WireFailure = {
  ok: false;
  error: TakibiFailure<string>;
};
export type WireResponse = WireSuccess | WireFailure;

export function encodeWireRequest(req: WireRequest): string {
  return JSON.stringify(req);
}

/**
 * Decode an internal wire body. Envelope checks (kind, CRUD operation
 * whitelist, required / exact fields, `context` object, list options) happen
 * here and fail as `BadRequestError`. Unknown collection or action names are
 * not resolved — they pass through and the executor reports `NOT_FOUND`.
 *
 * Collection `input` values are validated by the collection schema, not here.
 */
export function decodeWireRequest(body: unknown): WireRequest {
  if (!isRecord(body)) throw new BadRequestError("Invalid wire request");
  const r = body as Record<string, unknown>;
  assertContext(r.context);

  if (r.kind === "action") {
    assertExactKeys(r, ["kind", "scope", "name", "id", "input", "context"]);
    if (typeof r.scope !== "string" || typeof r.name !== "string") {
      throw new BadRequestError("Invalid action wire request");
    }
    if ("id" in r && (typeof r.id !== "string" || r.id === "")) {
      throw new BadRequestError("Invalid action id");
    }
    return r as ActionWireRequest;
  }

  if (r.kind !== "collection") throw new BadRequestError("Invalid wire request kind");
  if (typeof r.collection !== "string" || typeof r.operation !== "string") {
    throw new BadRequestError("Invalid CRUD wire request");
  }
  switch (r.operation) {
    case "add":
      assertExactKeys(r, ["kind", "collection", "operation", "id", "input", "context"]);
      if (!("input" in r)) throw new BadRequestError("Invalid CRUD wire request");
      if (r.id !== undefined && (typeof r.id !== "string" || r.id === "")) {
        throw new BadRequestError("Invalid CRUD id");
      }
      break;
    case "set":
    case "update":
      assertExactKeys(r, ["kind", "collection", "operation", "id", "input", "context"]);
      if (typeof r.id !== "string" || r.id === "" || !("input" in r)) {
        throw new BadRequestError("Invalid CRUD wire request");
      }
      break;
    case "get":
    case "delete":
      assertExactKeys(r, ["kind", "collection", "operation", "id", "context"]);
      if (typeof r.id !== "string" || r.id === "") throw new BadRequestError("Invalid CRUD id");
      break;
    case "list":
      try {
        assertExactKeys(r, ["kind", "collection", "operation", "list", "context"]);
        r.list = normalizeList(r.list);
      } catch (error) {
        throw new BadRequestError(error instanceof Error ? error.message : "Invalid list options");
      }
      break;
    default:
      throw new BadRequestError("Invalid CRUD operation");
  }
  return r as CollectionWireRequest;
}

function assertContext(value: unknown): asserts value is WireContext {
  if (!isRecord(value)) throw new BadRequestError("Invalid wire context");
}

function normalizeList(value: unknown): StorageListOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new BadRequestError("Invalid list options");
  assertExactKeys(value, ["limit", "cursor", "where"]);
  if (value.limit !== undefined) assertListLimit(value.limit);
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new BadRequestError("Invalid list cursor");
  }
  return {
    ...(value.limit !== undefined ? { limit: value.limit } : {}),
    ...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
    ...(value.where !== undefined ? { where: normalizeQueryExpr(value.where) } : {}),
  };
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new BadRequestError(`Unexpected wire field: ${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertListLimit(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BadRequestError("Invalid list limit");
  }
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

export function isWireResponse(value: unknown): value is WireResponse {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.ok === true) return "data" in r;
  if (r.ok !== false) return false;
  const error = r.error;
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (typeof e.code !== "string" || typeof e.message !== "string" || !isHttpStatus(e.status)) {
    return false;
  }
  if (e.kind === "validation") {
    return (
      !("reason" in e) && e.code === "VALIDATION" && e.status === 400 && Array.isArray(e.issues)
    );
  }
  if (e.kind === "operation") {
    if (!("reason" in e)) return true;
    return e.code === "FORBIDDEN" && isPolicyReason(e.reason);
  }
  return false;
}

function isPolicyReason(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "code" && key !== "description")) return false;
  return (
    typeof value.code === "string" &&
    (!("description" in value) || typeof value.description === "string")
  );
}
