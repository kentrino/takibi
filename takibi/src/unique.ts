import { AlreadyExistsError, TakibiError } from "./errors";
import { RESERVED_DOCUMENT_DATA_KEYS } from "./types";
import type {
  CollectionDefinition,
  QueryScalar,
  StorageDriver,
  StorageListPlan,
  StoredDocument,
} from "./types";

const CONSTRAINT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNIQUE_SCAN_PAGE_SIZE = 200;

type ParticipatingConstraint = {
  name: string;
  fields: readonly string[];
  values: readonly Exclude<QueryScalar, null>[];
};

export function assertCollectionUniqueConstraints(
  definition: CollectionDefinition,
  collection: string,
): void {
  const unique = definition.unique;
  if (unique === undefined) return;
  if (!isPlainRecord(unique)) {
    throw invalidCollection(collection, "unique must be a plain object");
  }

  for (const key of Reflect.ownKeys(unique)) {
    if (typeof key !== "string") {
      throw invalidCollection(collection, "unique constraint names must be strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(unique, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidCollection(collection, "unique constraints must be enumerable data properties");
    }
    if (!CONSTRAINT_NAME_PATTERN.test(key)) {
      throw invalidCollection(collection, `invalid unique constraint name: ${key}`);
    }
    assertConstraintFields(collection, key, descriptor.value);
  }
}

export async function assertUniqueDocument(
  definition: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  candidate: StoredDocument,
  plan?: StorageListPlan,
): Promise<void> {
  const constraints = participatingConstraints(definition, collection, candidate);
  if (constraints.length === 0) return;

  let cursor: string | undefined;
  do {
    const page = await storage.list(
      collection,
      {
        limit: UNIQUE_SCAN_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
      plan,
    );
    for (const document of page.items) {
      if (document.id === candidate.id) continue;
      for (const constraint of constraints) {
        if (matchesConstraint(document, constraint)) {
          throw new AlreadyExistsError(
            `Unique constraint violated: ${collection}.${constraint.name}`,
          );
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

function participatingConstraints(
  definition: CollectionDefinition,
  collection: string,
  document: Readonly<Record<string, unknown>>,
): ParticipatingConstraint[] {
  return Object.entries(definition.unique ?? {}).flatMap(([name, fields]) => {
    const values: Exclude<QueryScalar, null>[] = [];
    for (const field of fields as readonly string[]) {
      const value = document[field];
      if (value === undefined || value === null) return [];
      if (!isNonNullQueryScalar(value)) {
        throw invalidCollection(
          collection,
          `unique constraint ${name} field ${field} must contain a JSON scalar`,
        );
      }
      values.push(value);
    }
    return [{ name, fields, values }];
  });
}

function matchesConstraint(
  document: Readonly<Record<string, unknown>>,
  constraint: ParticipatingConstraint,
): boolean {
  return constraint.fields.every(
    (field, index) =>
      Object.prototype.hasOwnProperty.call(document, field) &&
      document[field] === constraint.values[index],
  );
}

function assertConstraintFields(collection: string, name: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidCollection(collection, `unique constraint ${name} must be a non-empty tuple`);
  }
  const seen = new Set<string>();
  for (const field of value) {
    if (typeof field !== "string" || field.length === 0) {
      throw invalidCollection(collection, `unique constraint ${name} fields must be strings`);
    }
    if ((RESERVED_DOCUMENT_DATA_KEYS as readonly string[]).includes(field)) {
      throw invalidCollection(
        collection,
        `unique constraint ${name} cannot use reserved field ${field}`,
      );
    }
    if (seen.has(field)) {
      throw invalidCollection(collection, `unique constraint ${name} repeats field ${field}`);
    }
    seen.add(field);
  }
}

function isNonNullQueryScalar(value: unknown): value is Exclude<QueryScalar, null> {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidCollection(collection: string, message: string): TakibiError {
  return new TakibiError("INVALID_COLLECTION", `${collection}: ${message}`, 500);
}
