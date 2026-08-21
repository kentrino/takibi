import { TakibiError } from "./errors";
import type { ExecuteRequest } from "./executor";
import { emitFailure, loggedStorage, type InternalLogger, type LoggingOptions } from "./logging";
import type { PublicRequest } from "./http";
import type { WireFailure } from "./protocol";
import { toTakibiFailure } from "./result";
import { SchemaValidationError } from "./schema";
import type { StorageDriver } from "./types";

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

export function invocationFields(invocation: PublicRequest): {
  collection?: string;
  operation: string;
  documentId?: string;
} {
  return invocation.kind === "action"
    ? {
        ...(invocation.scope === "$" ? {} : { collection: invocation.scope }),
        operation: invocation.name,
      }
    : {
        collection: invocation.collection,
        operation: invocation.operation,
        ...(invocation.id === undefined ? {} : { documentId: invocation.id }),
      };
}

export function debugInvocationFields(invocation: PublicRequest): ReturnType<
  typeof invocationFields
> & {
  query?: NonNullable<ExecuteRequest["list"]>["where"];
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
): Response {
  const wire = toWireError(error);
  emitFailure(logger, wire.error, invocation === undefined ? {} : invocationFields(invocation));
  return Response.json(wire, { status: statusOf(error) });
}

function toWireError(err: unknown): WireFailure {
  if (err instanceof SchemaValidationError || err instanceof TakibiError) {
    return { ok: false, error: toTakibiFailure(err) };
  }
  return {
    ok: false,
    error: {
      kind: "operation",
      code: "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
      status: 500,
    },
  };
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
