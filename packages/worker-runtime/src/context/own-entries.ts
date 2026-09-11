import { TakibiError } from "@takibi/api";

type EntryCode = "INVALID_COLLECTION" | "INVALID_ACTION";
type EntryLabels = { subject: string; keys: string };

export function ownStringEntries<T>(
  value: Readonly<Record<string, T>>,
  code: EntryCode,
  labels: EntryLabels,
): Generator<[string, T]>;
export function ownStringEntries(
  value: unknown,
  code: EntryCode,
  labels: EntryLabels,
): Generator<[string, unknown]>;

/**
 * Walk enumerable own string keys of a plain object. Used to reject class
 * instances, symbols, getters, and non-enumerable fields at the public
 * collection / action-map boundaries.
 */
export function* ownStringEntries(
  value: unknown,
  code: EntryCode,
  labels: EntryLabels,
): Generator<[string, unknown]> {
  if (typeof value !== "object" || value === null) {
    throw new TakibiError(code, `${labels.subject} must be an object`, 500);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TakibiError(code, `${labels.subject} must be a plain object`, 500);
  }
  for (const propertyKey of Reflect.ownKeys(value)) {
    if (typeof propertyKey !== "string") {
      throw new TakibiError(code, `${labels.keys} must be strings`, 500);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, propertyKey);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TakibiError(
        code,
        `${labels.subject} must be enumerable data properties: ${propertyKey}`,
        500,
      );
    }
    yield [propertyKey, descriptor.value];
  }
}
