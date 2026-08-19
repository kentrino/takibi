import type { JsonValue } from "./types";

export type JsonValidationOptions = {
  subject: string;
  error: (message: string) => Error;
};

export function assertJsonValue(
  value: unknown,
  options: JsonValidationOptions,
): asserts value is JsonValue {
  visitJsonValue(value, options, new Set<object>());
}

export function assertJsonObject(
  value: unknown,
  options: JsonValidationOptions,
): asserts value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw options.error(`${options.subject} must be a plain JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw options.error(`${options.subject} must be a plain JSON object`);
  }
  visitJsonValue(value, options, new Set<object>());
}

function visitJsonValue(value: unknown, options: JsonValidationOptions, seen: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw options.error(`${options.subject} must be JSON-safe`);
  }
  if (seen.has(value)) {
    throw options.error(`${options.subject} must not be cyclic`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw options.error(`${options.subject} arrays must contain only data elements`);
      }
      visitJsonValue(descriptor.value, options, seen);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw options.error(`${options.subject} arrays must not have custom properties`);
      }
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw options.error(`${options.subject} must contain only plain JSON objects`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw options.error(`${options.subject} must not contain symbol properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw options.error(`${options.subject} must contain only enumerable data properties`);
    }
    visitJsonValue(descriptor.value, options, seen);
  }
  seen.delete(value);
}
