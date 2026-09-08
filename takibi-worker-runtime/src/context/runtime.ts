import { TakibiError } from "@takibi/takibi-api";
import type { PublicRequest } from "../http";
import {
  emitFailure,
  loggedStorage,
  requestLogFields,
  type InternalLogger,
  type LoggingOptions,
} from "../logging";
import type {
  ObserverInvocationData,
  StorageListOptions,
  TakibiFailure,
} from "@takibi/takibi-shared-types";
import type { WireFailure } from "../protocol";
import { toTakibiFailure } from "../result";
import { SchemaValidationError } from "../schema";
import type { StorageDriver } from "@takibi/takibi-storage";

/**
 * Fields read by invocation log helpers. Shared by observer-safe values,
 * wire invocations, and public requests; batch exists only on the last.
 */
type InvocationFieldSource = ObserverInvocationData | Extract<PublicRequest, { kind: "batch" }>;

export function applyStorageLogging(
  driver: StorageDriver,
  logger: InternalLogger | undefined,
): StorageDriver {
  return logger ? loggedStorage(driver, logger) : driver;
}

export function mergeLoggingOptions(
  base: LoggingOptions,
  override: LoggingOptions,
): LoggingOptions {
  const merged = { ...base };
  if (Object.prototype.hasOwnProperty.call(override, "logger")) {
    merged.logger = override.logger;
  }
  if (Object.prototype.hasOwnProperty.call(override, "logLevel")) {
    merged.logLevel = override.logLevel;
  }
  return merged;
}

export function invocationFields(invocation: InvocationFieldSource): {
  collection?: string;
  operation?: string;
  documentId?: string;
  batchSize?: number;
} {
  if (invocation.kind === "batch") {
    return { batchSize: invocation.items.length };
  }
  return invocation.kind === "action"
    ? {
        ...(invocation.scope === "$" ? {} : { collection: invocation.scope }),
        operation: invocation.name,
        ...(invocation.id === undefined ? {} : { documentId: invocation.id }),
      }
    : {
        collection: invocation.collection,
        operation: invocation.operation,
        ...(invocation.id === undefined ? {} : { documentId: invocation.id }),
      };
}

export function debugInvocationFields(invocation: InvocationFieldSource): ReturnType<
  typeof invocationFields
> & {
  query?: StorageListOptions["where"];
} {
  return {
    ...invocationFields(invocation),
    ...(invocation.kind === "collection" && invocation.list?.where !== undefined
      ? { query: invocation.list.where }
      : {}),
  };
}

export function errorResponse(
  error: unknown,
  logger: InternalLogger | undefined,
  invocation?: PublicRequest,
  request?: Request,
): Response {
  const wire = toWireFailure(error);
  emitFailure(logger, wire.error, {
    ...(invocation === undefined ? {} : invocationFields(invocation)),
    ...(request === undefined ? {} : requestLogFields(request)),
  });
  return Response.json(wire, { status: statusOf(error) });
}

export function normalizeInvocationFailure(error: unknown): TakibiFailure<string> {
  if (error instanceof SchemaValidationError || error instanceof TakibiError) {
    return toTakibiFailure(error);
  }
  return {
    kind: "operation",
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
    status: 500,
  };
}

export function toWireFailure(err: unknown): WireFailure {
  return { ok: false, error: normalizeInvocationFailure(err) };
}

function statusOf(err: unknown): number {
  if (err instanceof TakibiError) return err.status;
  if (err instanceof SchemaValidationError) return 400;
  return 500;
}

export function assertSerializableContext(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TakibiError("INVALID_CONTEXT", "Resolved context must be a plain object", 500);
  }
  assertSerializableValue(value, new Set<object>());
}

function assertSerializableValue(value: unknown, seen: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new TakibiError("INVALID_CONTEXT", "Resolved context must be JSON-safe", 500);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TakibiError("INVALID_CONTEXT", "Resolved context arrays must contain data", 500);
      }
      assertSerializableValue(descriptor.value, seen);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw new TakibiError(
          "INVALID_CONTEXT",
          "Resolved context arrays must not have custom properties",
          500,
        );
      }
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TakibiError("INVALID_CONTEXT", "Resolved context must use plain objects", 500);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TakibiError("INVALID_CONTEXT", "Resolved context must not contain symbols", 500);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TakibiError(
        "INVALID_CONTEXT",
        "Resolved context must contain only enumerable data properties",
        500,
      );
    }
    assertSerializableValue(descriptor.value, seen);
  }
  seen.delete(value);
}
