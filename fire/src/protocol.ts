import type { ActionInvocation } from "./action-executor";
import { BadRequestError } from "./errors";
import type { ExecuteRequest } from "./executor";
import { normalizeQueryExpr } from "./query";
import type { FireFailure } from "./types";
import type { StorageListOptions } from "./types";

type WireContext = {
  tenantId: string;
  user: unknown;
  [key: string]: unknown;
};

export type CrudWireRequest = ExecuteRequest & { context: WireContext };
export type ActionWireRequest = ActionInvocation & { context: WireContext };
export type WireRequest = CrudWireRequest | ActionWireRequest;

export type WireSuccess = { ok: true; data: unknown };
export type WireFailure = {
  ok: false;
  error: FireFailure;
};
export type WireResponse = WireSuccess | WireFailure;

export function encodeWireRequest(req: WireRequest): string {
  return JSON.stringify(req);
}

export function decodeWireRequest(body: unknown): WireRequest {
  if (!isRecord(body)) throw new Error("Invalid wire request");
  const r = body as Record<string, unknown>;
  assertContext(r.context);

  if (r.kind === "action") {
    assertExactKeys(r, ["kind", "scope", "name", "input", "context"]);
    if (typeof r.scope !== "string" || typeof r.name !== "string") {
      throw new Error("Invalid action wire request");
    }
    return r as ActionWireRequest;
  }

  if (r.kind !== "crud") throw new Error("Invalid wire request kind");
  if (typeof r.collection !== "string" || typeof r.operation !== "string") {
    throw new Error("Invalid CRUD wire request");
  }
  switch (r.operation) {
    case "add":
      assertExactKeys(r, ["kind", "collection", "operation", "id", "input", "context"]);
      if (!("input" in r)) throw new Error("Invalid CRUD wire request");
      if (r.id !== undefined && typeof r.id !== "string") throw new Error("Invalid CRUD id");
      break;
    case "set":
    case "update":
      assertExactKeys(r, ["kind", "collection", "operation", "id", "input", "context"]);
      if (typeof r.id !== "string" || !("input" in r)) {
        throw new Error("Invalid CRUD wire request");
      }
      break;
    case "get":
    case "delete":
      assertExactKeys(r, ["kind", "collection", "operation", "id", "context"]);
      if (typeof r.id !== "string") throw new Error("Invalid CRUD id");
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
      throw new Error("Invalid CRUD operation");
  }
  return r as CrudWireRequest;
}

function assertContext(value: unknown): asserts value is WireContext {
  if (
    !isRecord(value) ||
    typeof value.tenantId !== "string" ||
    !Object.prototype.hasOwnProperty.call(value, "user")
  ) {
    throw new Error("Invalid wire context");
  }
}

function normalizeList(value: unknown): StorageListOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid list options");
  assertExactKeys(value, ["limit", "cursor", "where"]);
  if (value.limit !== undefined && typeof value.limit !== "number") {
    throw new Error("Invalid list limit");
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new Error("Invalid list cursor");
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
    if (!allowedKeys.has(key)) throw new Error(`Unexpected wire field: ${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWireResponse(value: unknown): value is WireResponse {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.ok === true) return "data" in r;
  if (r.ok !== false) return false;
  const error = r.error;
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (typeof e.code !== "string" || typeof e.message !== "string" || typeof e.status !== "number") {
    return false;
  }
  if (e.kind === "validation") {
    return e.code === "VALIDATION" && e.status === 400 && Array.isArray(e.issues);
  }
  if (e.kind === "operation") return true;
  return false;
}
