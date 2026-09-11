import type {
  ActionRequestData,
  CollectionOperation,
  CollectionRequestData,
  StorageListOptions,
  TakibiFailure,
} from "@takibi/takibi-shared-types";
import { TakibiProtocolError } from "./error";
import { normalizeOrderBy, normalizeQueryExpr } from "./query";

export type WireContext = Record<string, unknown>;

export const MAX_BATCH_ITEMS = 20;

export const COLLECTION_READ_OPERATIONS = ["get", "list"] as const;
export type CollectionReadOperation = (typeof COLLECTION_READ_OPERATIONS)[number];
export type CollectionWireOperation = CollectionOperation;

export function isCollectionReadOperation(operation: string): operation is CollectionReadOperation {
  return operation === "get" || operation === "list";
}

export type CollectionReadRequest = Omit<CollectionRequestData, "operation" | "input"> & {
  operation: CollectionReadOperation;
};

export type PublicBatchRequest = {
  kind: "batch";
  items: CollectionReadRequest[];
};

export type CollectionWireRequest = CollectionRequestData & { context: WireContext };

export type ActionWireRequest = ActionRequestData & { context: WireContext };

export type BatchWireRequest = PublicBatchRequest & { context: WireContext };
export type WireRequest = CollectionWireRequest | ActionWireRequest | BatchWireRequest;

export type WireSuccess = { ok: true; data: unknown };
export type WireFailure = {
  ok: false;
  error: TakibiFailure<string>;
};
export type WireResponse = WireSuccess | WireFailure;

export function encodeWireRequest(request: WireRequest): string {
  return JSON.stringify(request);
}

export function parseWireRequest(source: string): WireRequest {
  if (typeof source !== "string") {
    throw new TakibiProtocolError("Wire request must be a JSON string");
  }
  try {
    return decodeWireRequest(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof TakibiProtocolError) throw error;
    throw new TakibiProtocolError("Invalid JSON wire request");
  }
}

/**
 * Decode an internal wire value. Collection and action names deliberately
 * remain unresolved; execution owns registry lookup.
 */
export function decodeWireRequest(body: unknown): WireRequest {
  if (!isRecord(body)) throw new TakibiProtocolError("Invalid wire request");
  const request = body;
  assertContext(request.context);

  if (request.kind === "action") {
    assertExactKeys(request, ["kind", "scope", "name", "id", "input", "context"]);
    if (typeof request.scope !== "string" || typeof request.name !== "string") {
      throw new TakibiProtocolError("Invalid action wire request");
    }
    if ("id" in request && (typeof request.id !== "string" || request.id === "")) {
      throw new TakibiProtocolError("Invalid action id");
    }
    return request as ActionWireRequest;
  }

  if (request.kind === "batch") {
    assertExactKeys(request, ["kind", "items", "context"]);
    return {
      kind: "batch",
      items: decodeBatchItems(request.items),
      context: request.context,
    };
  }

  if (request.kind !== "collection") {
    throw new TakibiProtocolError("Invalid wire request kind");
  }
  if (typeof request.collection !== "string" || typeof request.operation !== "string") {
    throw new TakibiProtocolError("Invalid CRUD wire request");
  }
  switch (request.operation) {
    case "add":
      assertExactKeys(request, ["kind", "collection", "operation", "id", "input", "context"]);
      if (!("input" in request)) {
        throw new TakibiProtocolError("Invalid CRUD wire request");
      }
      if (request.id !== undefined && (typeof request.id !== "string" || request.id === "")) {
        throw new TakibiProtocolError("Invalid CRUD id");
      }
      break;
    case "set":
    case "update":
      assertExactKeys(request, ["kind", "collection", "operation", "id", "input", "context"]);
      if (typeof request.id !== "string" || request.id === "" || !("input" in request)) {
        throw new TakibiProtocolError("Invalid CRUD wire request");
      }
      break;
    case "get":
    case "delete":
      assertExactKeys(request, ["kind", "collection", "operation", "id", "context"]);
      if (typeof request.id !== "string" || request.id === "") {
        throw new TakibiProtocolError("Invalid CRUD id");
      }
      break;
    case "list":
      assertExactKeys(request, ["kind", "collection", "operation", "list", "context"]);
      request.list = normalizeList(request.list);
      break;
    default:
      throw new TakibiProtocolError("Invalid CRUD operation");
  }
  return request as CollectionWireRequest;
}

export function decodePublicBatch(body: unknown): PublicBatchRequest {
  if (!isRecord(body)) throw new TakibiProtocolError("Invalid batch request");
  assertExactKeys(body, ["kind", "items"]);
  if (body.kind !== "batch") throw new TakibiProtocolError("Invalid batch request");
  return { kind: "batch", items: decodeBatchItems(body.items) };
}

export function decodeBatchItems(value: unknown): CollectionReadRequest[] {
  if (!Array.isArray(value)) throw new TakibiProtocolError("Invalid batch items");
  if (value.length === 0) throw new TakibiProtocolError("Empty batch");
  if (value.length > MAX_BATCH_ITEMS) throw new TakibiProtocolError("Batch too large");
  return value.map(decodeCollectionReadRequest);
}

export function decodeCollectionReadRequest(value: unknown): CollectionReadRequest {
  if (!isRecord(value)) throw new TakibiProtocolError("Invalid batch item");
  if (value.kind !== "collection") {
    throw new TakibiProtocolError("Invalid batch item kind");
  }
  if (typeof value.collection !== "string" || typeof value.operation !== "string") {
    throw new TakibiProtocolError("Invalid CRUD wire request");
  }
  if (!isCollectionReadOperation(value.operation)) {
    throw new TakibiProtocolError("Batch items must be collection reads");
  }
  if (value.operation === "get") {
    assertExactKeys(value, ["kind", "collection", "operation", "id"]);
    if (typeof value.id !== "string" || value.id === "") {
      throw new TakibiProtocolError("Invalid CRUD id");
    }
    return {
      kind: "collection",
      collection: value.collection,
      operation: "get",
      id: value.id,
    };
  }
  assertExactKeys(value, ["kind", "collection", "operation", "list"]);
  const list = normalizeList(value.list);
  return {
    kind: "collection",
    collection: value.collection,
    operation: "list",
    ...(list === undefined ? {} : { list }),
  };
}

function assertContext(value: unknown): asserts value is WireContext {
  if (!isRecord(value)) throw new TakibiProtocolError("Invalid wire context");
}

function normalizeList(value: unknown): StorageListOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TakibiProtocolError("Invalid list options");
  assertExactKeys(value, ["limit", "cursor", "where", "index", "orderBy"]);
  if (value.limit !== undefined) assertListLimit(value.limit);
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new TakibiProtocolError("Invalid list cursor");
  }
  if (value.index !== undefined && (typeof value.index !== "string" || value.index.length === 0)) {
    throw new TakibiProtocolError("Invalid list index");
  }
  if (value.orderBy !== undefined && value.index === undefined) {
    throw new TakibiProtocolError("orderBy requires index");
  }
  return {
    ...(value.limit !== undefined ? { limit: value.limit } : {}),
    ...(value.cursor !== undefined ? { cursor: value.cursor } : {}),
    ...(value.where !== undefined ? { where: normalizeQueryExpr(value.where) } : {}),
    ...(value.index !== undefined ? { index: value.index } : {}),
    ...(value.orderBy !== undefined ? { orderBy: normalizeOrderBy(value.orderBy) } : {}),
  };
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TakibiProtocolError(`Unexpected wire field: ${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertListLimit(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TakibiProtocolError("Invalid list limit");
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
  const response = value as Record<string, unknown>;
  if (response.ok === true) return "data" in response;
  if (response.ok !== false) return false;
  const error = response.error;
  if (!error || typeof error !== "object") return false;
  const failure = error as Record<string, unknown>;
  if (
    typeof failure.code !== "string" ||
    typeof failure.message !== "string" ||
    !isHttpStatus(failure.status)
  ) {
    return false;
  }
  if (failure.kind === "validation") {
    return (
      !("reason" in failure) &&
      failure.code === "VALIDATION" &&
      failure.status === 400 &&
      Array.isArray(failure.issues)
    );
  }
  if (failure.kind === "operation") {
    if (!("reason" in failure)) return true;
    return failure.code === "FORBIDDEN" && isPolicyReason(failure.reason);
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
