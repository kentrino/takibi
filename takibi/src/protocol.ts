import type { ActionInvocation } from "./action-executor";
import { BadRequestError } from "./errors";
import type { ExecuteRequest } from "./executor";
import { normalizeQueryExpr } from "./query";
import type { TakibiFailure } from "./types";
import type { StorageListOptions } from "./types";

type WireContext = Record<string, unknown>;

export const MAX_BATCH_ITEMS = 20;

export const COLLECTION_READ_OPERATIONS = ["get", "list"] as const;
export type CollectionReadOperation = (typeof COLLECTION_READ_OPERATIONS)[number];

export function isCollectionReadOperation(operation: string): operation is CollectionReadOperation {
  return operation === "get" || operation === "list";
}

export type CollectionReadRequest = {
  kind: "collection";
  collection: string;
  operation: CollectionReadOperation;
  id?: string;
  list?: StorageListOptions;
};

export type PublicBatchRequest = {
  kind: "batch";
  items: CollectionReadRequest[];
};

export type CollectionWireRequest = ExecuteRequest & { context: WireContext };
export type ActionWireRequest = ActionInvocation & { context: WireContext };
export type BatchWireRequest = PublicBatchRequest & { context: WireContext };
export type WireRequest = CollectionWireRequest | ActionWireRequest | BatchWireRequest;

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

  if (r.kind === "batch") {
    assertExactKeys(r, ["kind", "items", "context"]);
    return { kind: "batch", items: decodeBatchItems(r.items), context: r.context };
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

export function decodePublicBatch(body: unknown): PublicBatchRequest {
  if (!isRecord(body)) throw new BadRequestError("Invalid batch request");
  assertExactKeys(body, ["kind", "items"]);
  if (body.kind !== "batch") throw new BadRequestError("Invalid batch request");
  return { kind: "batch", items: decodeBatchItems(body.items) };
}

export function decodeBatchItems(value: unknown): CollectionReadRequest[] {
  if (!Array.isArray(value)) throw new BadRequestError("Invalid batch items");
  if (value.length === 0) throw new BadRequestError("Empty batch");
  if (value.length > MAX_BATCH_ITEMS) throw new BadRequestError("Batch too large");
  return value.map(decodeCollectionReadRequest);
}

export function decodeCollectionReadRequest(value: unknown): CollectionReadRequest {
  if (!isRecord(value)) throw new BadRequestError("Invalid batch item");
  if (value.kind !== "collection") throw new BadRequestError("Invalid batch item kind");
  if (typeof value.collection !== "string" || typeof value.operation !== "string") {
    throw new BadRequestError("Invalid CRUD wire request");
  }
  if (!isCollectionReadOperation(value.operation)) {
    throw new BadRequestError("Batch items must be collection reads");
  }
  if (value.operation === "get") {
    assertExactKeys(value, ["kind", "collection", "operation", "id"]);
    if (typeof value.id !== "string" || value.id === "") {
      throw new BadRequestError("Invalid CRUD id");
    }
    return {
      kind: "collection",
      collection: value.collection,
      operation: "get",
      id: value.id,
    };
  }
  assertExactKeys(value, ["kind", "collection", "operation", "list"]);
  try {
    const list = normalizeList(value.list);
    return {
      kind: "collection",
      collection: value.collection,
      operation: "list",
      ...(list === undefined ? {} : { list }),
    };
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : "Invalid list options");
  }
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

export function isBatchWireResponse(
  value: unknown,
  itemCount: number,
): value is WireSuccess & { data: WireResponse[] } {
  if (!isWireResponse(value) || value.ok !== true) return false;
  if (!Array.isArray(value.data) || value.data.length !== itemCount) return false;
  return value.data.every((item) => isWireResponse(item));
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
