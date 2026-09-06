import { TakibiError, type CollectionDefinition, type CollectionsDef } from "@takibi/takibi-api";
import type { WithMetadata } from "@takibi/takibi-shared-types";
import { assertJsonObject } from "./json";
import type { InternalLogger } from "./logging";
import { documentRevision } from "./revision";
import { parseSchema, parseSchemaUnobserved, SchemaValidationError } from "./schema";
import {
  RESERVED_DOCUMENT_DATA_KEYS,
  TAKIBI_REVISION_KEY,
  TAKIBI_VERSION_KEY,
} from "@takibi/takibi-shared-types";
import {
  assertDocumentIndexFields,
  type StorageDriver,
  type StorageListPlan,
  type StoredDocument,
} from "@takibi/takibi-storage";
import { assertUniqueDocument } from "./unique";

export function assertCollectionMigrations(
  definition: CollectionDefinition,
  collection: string,
): void {
  const migrations = definition.migrations;
  if (migrations === undefined) return;
  const base = migrations.base ?? 0;
  if (!Number.isInteger(base) || base < 0) {
    throw new TakibiError(
      "INVALID_COLLECTION",
      `Migration base must be a non-negative integer: ${collection}`,
      500,
    );
  }
}

export function createMigratingStorage(
  collections: CollectionsDef,
  storage: StorageDriver,
  logger?: InternalLogger,
): StorageDriver {
  const definitionFor = (collection: string): CollectionDefinition => {
    const definition = collections[collection];
    if (!definition) {
      throw new TakibiError("INVALID_COLLECTION", `Unknown collection: ${collection}`, 500);
    }
    return definition;
  };

  return {
    async get(collection, id) {
      const stored = await storage.get(collection, id);
      if (!stored) return null;
      return migrateDocument(definitionFor(collection), storage, collection, stored, logger);
    },
    async put(collection, document) {
      const definition = definitionFor(collection);
      const current = withCurrentVersion(definition, document);
      assertDocumentIndexFields(definition, collection, current);
      await storage.transaction(async (scoped) => {
        await assertUniqueDocument(
          definition,
          scoped,
          collection,
          current,
          currentDocumentReadPlan(definition, logger),
        );
        await scoped.put(collection, current);
      });
    },
    delete(collection, id) {
      return storage.delete(collection, id);
    },
    list(collection, options, plan) {
      const definition = definitionFor(collection);
      return storage.list(collection, options, {
        currentVersion: currentVersion(definition),
        transform: async (stored) => {
          const migrated = await migrateDocument(definition, storage, collection, stored, logger);
          return plan ? plan.transform(migrated) : migrated;
        },
      });
    },
    transaction(callback) {
      return storage.transaction((scoped) =>
        callback(createMigratingStorage(collections, scoped, logger)),
      );
    },
  };
}

async function migrateDocument(
  definition: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  stored: StoredDocument,
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  const storedVersion = readStoredVersion(stored);
  const targetVersion = currentVersion(definition);

  if (storedVersion === targetVersion) return withoutVersion(stored);

  const migrated = await migrateStoredDocument(definition, stored, logger);
  assertDocumentIndexFields(definition, collection, migrated);
  await storage.transaction(async (scoped) => {
    await assertUniqueDocument(
      definition,
      scoped,
      collection,
      migrated,
      currentDocumentReadPlan(definition, logger),
    );
    await scoped.put(collection, migrated);
  });
  return withoutVersion(migrated);
}

function currentDocumentReadPlan(
  definition: CollectionDefinition,
  logger?: InternalLogger,
): StorageListPlan {
  return {
    currentVersion: currentVersion(definition),
    transform: async (stored) =>
      withoutVersion(await migrateStoredDocument(definition, stored, logger)),
  };
}

async function migrateStoredDocument(
  definition: CollectionDefinition,
  stored: StoredDocument,
  logger?: InternalLogger,
): Promise<StoredDocument> {
  const migrations = definition.migrations;
  const base = migrations?.base ?? 0;
  const steps = migrations?.steps ?? [];
  const targetVersion = base + steps.length;
  const storedVersion = readStoredVersion(stored);

  if (storedVersion < base) {
    throw new TakibiError(
      "MIGRATION_UNAVAILABLE",
      `Document version ${storedVersion} is below migration base ${base}`,
      500,
    );
  }
  if (storedVersion > targetVersion) {
    throw new TakibiError(
      "MIGRATION_VERSION",
      `Document version ${storedVersion} is newer than collection version ${targetVersion}`,
      500,
    );
  }
  if (storedVersion === targetVersion) return stored;

  let data: unknown = domainData(stored);
  for (let version = storedVersion; version < targetVersion; version += 1) {
    const step = steps[version - base];
    if (!step) {
      throw new TakibiError(
        "MIGRATION_UNAVAILABLE",
        `No migration step from document version ${version}`,
        500,
      );
    }
    data = step(data);
    if (isPromiseLike(data)) {
      throw new TakibiError("INVALID_MIGRATION", "Migration steps must be synchronous", 500);
    }
  }

  const parsed = await parseSchema(definition.schema, data, logger);
  assertJsonObject(parsed, {
    subject: "Collection document",
    error: (message) => new TakibiError("INVALID_DOCUMENT", message, 500),
  });
  assertNoReservedOutput(parsed);
  return {
    ...parsed,
    id: stored.id,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    rev: documentRevision(stored),
    [TAKIBI_VERSION_KEY]: targetVersion,
  };
}

export async function validateStoredDocumentForRestore(
  definition: CollectionDefinition,
  stored: StoredDocument,
): Promise<StoredDocument> {
  const migrations = definition.migrations;
  const base = migrations?.base ?? 0;
  const steps = migrations?.steps ?? [];
  const targetVersion = base + steps.length;
  const storedVersion = readStoredVersion(stored);
  if (storedVersion < base || storedVersion > targetVersion) {
    throw new TakibiError(
      "MIGRATION_VERSION",
      `Document version ${storedVersion} is outside the supported range ${base}..${targetVersion}`,
      500,
    );
  }

  let data: unknown = domainData(stored);
  for (let version = storedVersion; version < targetVersion; version += 1) {
    const step = steps[version - base];
    if (!step) {
      throw new TakibiError(
        "MIGRATION_UNAVAILABLE",
        `No migration step from document version ${version}`,
        500,
      );
    }
    data = step(data);
    if (isPromiseLike(data)) {
      throw new TakibiError("INVALID_MIGRATION", "Migration steps must be synchronous", 500);
    }
  }

  const parsed = await parseSchemaUnobserved(definition.schema, data);
  assertJsonObject(parsed, {
    subject: "Collection document",
    error: (message) => new TakibiError("INVALID_DOCUMENT", message, 500),
  });
  assertNoReservedOutput(parsed);
  const migrated: StoredDocument = {
    ...parsed,
    id: stored.id,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    rev: documentRevision(stored),
    [TAKIBI_VERSION_KEY]: targetVersion,
  };
  return migrated;
}

export function currentCollectionVersion(definition: CollectionDefinition): number {
  const migrations = definition.migrations;
  return (migrations?.base ?? 0) + (migrations?.steps.length ?? 0);
}

function currentVersion(definition: CollectionDefinition): number {
  return currentCollectionVersion(definition);
}

function withCurrentVersion(
  definition: CollectionDefinition,
  document: StoredDocument,
): StoredDocument {
  return {
    ...withoutVersion(document),
    [TAKIBI_VERSION_KEY]: currentVersion(definition),
  };
}

function readStoredVersion(document: StoredDocument): number {
  const value = document[TAKIBI_VERSION_KEY];
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TakibiError(
      "MIGRATION_VERSION",
      "Stored document has an invalid migration version",
      500,
    );
  }
  return value as number;
}

function domainData(document: StoredDocument): Record<string, unknown> {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    [TAKIBI_REVISION_KEY]: _rev,
    [TAKIBI_VERSION_KEY]: _version,
    ...data
  } = document;
  return structuredClone(data);
}

function withoutVersion(document: StoredDocument): WithMetadata<Record<string, unknown>> {
  const { [TAKIBI_VERSION_KEY]: _version, ...publicDocument } = document;
  return publicDocument;
}

function assertNoReservedOutput(parsed: Record<string, unknown>): void {
  for (const key of RESERVED_DOCUMENT_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new SchemaValidationError([
        {
          message: `${key} is reserved and must not appear in document data`,
          path: [key],
        },
      ]);
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
