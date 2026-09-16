import type { StorageListOptions, TakibiFailure } from "@takibi/shared-types";
import { TakibiProtocolError } from "./error";
import { decodeCollectionReadRequest, decodeWireRequest, isWireResponse } from "./wire";

export const WATCH_VERSION = 1;
export const WATCH_PROTOCOL = "takibi.watch.v1";
export const WATCH_PROTOCOL_CLOSE = 4400;
export const WATCH_ERROR_CLOSE = 4403;
export const WATCH_MAINTENANCE_CLOSE = 1013;
export const WATCH_ATTACHMENT_MAX_BYTES = 16_384;
export type WatchAttachment = {
  version: typeof WATCH_VERSION;
  collection: string;
  list: StorageListOptions;
  context: Record<string, unknown>;
};
export type WatchEnvelope =
  | { version: typeof WATCH_VERSION; kind: "snapshot"; items: unknown[] }
  | {
      version: typeof WATCH_VERSION;
      kind: "error";
      reason: "server-error" | "protocol-error";
      error: TakibiFailure<string>;
    };

export function normalizeWatchList(value: unknown): StorageListOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value) || "cursor" in value) {
    throw new TakibiProtocolError("Watch options must be an object without cursor");
  }
  return (
    decodeCollectionReadRequest({
      kind: "collection",
      collection: "watch",
      operation: "list",
      list: value,
    }).list ?? {}
  );
}

export function decodeWatchAttachment(value: unknown): WatchAttachment {
  assertObject(value);
  exactKeys(value, ["version", "collection", "list", "context"]);
  if (
    value.version !== WATCH_VERSION ||
    typeof value.collection !== "string" ||
    !value.collection
  ) {
    throw new TakibiProtocolError("Obsolete or invalid watch attachment");
  }
  const list = normalizeWatchList(value.list);
  const wire = decodeWireRequest({
    kind: "collection",
    operation: "list",
    collection: value.collection,
    list,
    context: value.context,
  });
  return { version: WATCH_VERSION, collection: value.collection, list, context: wire.context };
}

export function parseWatchEnvelope(source: unknown): WatchEnvelope {
  if (typeof source !== "string") throw new TakibiProtocolError("Expected a text watch frame");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TakibiProtocolError("Invalid watch JSON");
  }
  assertObject(value);
  if (value.version !== WATCH_VERSION) throw new TakibiProtocolError("Unsupported watch version");
  if (value.kind === "snapshot") {
    exactKeys(value, ["version", "kind", "items"]);
    if (
      !Array.isArray(value.items) ||
      value.items.some((item) => typeof item !== "object" || item === null || Array.isArray(item))
    ) {
      throw new TakibiProtocolError("Invalid watch snapshot");
    }
    return { version: WATCH_VERSION, kind: "snapshot", items: value.items };
  }
  if (value.kind === "error") {
    exactKeys(value, ["version", "kind", "reason", "error"]);
    if (value.reason !== "server-error" && value.reason !== "protocol-error")
      throw new TakibiProtocolError("Invalid watch error reason");
    assertObject(value.error);
    exactKeys(
      value.error,
      value.error.kind === "validation"
        ? ["kind", "code", "message", "status", "issues"]
        : ["kind", "code", "message", "status", "reason"],
    );
    const wire = { ok: false, error: value.error };
    if (isWireResponse(wire) && !wire.ok)
      return { version: WATCH_VERSION, kind: "error", reason: value.reason, error: wire.error };
  }
  throw new TakibiProtocolError("Invalid watch envelope");
}
function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TakibiProtocolError("Expected watch object");
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new TakibiProtocolError("Unknown watch field");
}
