import {
  SnapshotIncompatibleError,
  SnapshotInvalidDocumentError,
  TakibiError,
  type CollectionDefinition,
  type CollectionsDef,
  type DurableObjectCollectionsApi,
  type TrustedCollectionsApi,
} from "@takibi/api";
import { TAKIBI_VERSION_KEY } from "@takibi/shared-types";
import {
  attachSnapshotOperations,
  type MaintenanceController,
  type SnapshotLifecycle,
  type SnapshotStoredDocument,
  type SnapshotUniqueConstraint,
} from "@takibi/snapshot";
import { assertDocumentIndexFields, compareUtf8, type StoredDocument } from "@takibi/storage";
import { currentCollectionVersion, validateStoredDocumentForRestore } from "./migrations";
import { prepareAddDoc } from "./typed-storage";
import type { InternalLogger } from "./logging";

export function createDurableObjectCollectionsApi<TCollections extends CollectionsDef>(
  trusted: TrustedCollectionsApi<TCollections>,
  collections: TCollections,
  maintenance: MaintenanceController,
  ready: Promise<void>,
  logger?: InternalLogger,
): DurableObjectCollectionsApi<TCollections> {
  return attachSnapshotOperations(
    trusted,
    maintenance,
    ready,
    createTakibiSnapshotLifecycle(collections, logger),
  );
}

export function createTakibiSnapshotLifecycle(
  collections: CollectionsDef,
  logger?: InternalLogger,
): SnapshotLifecycle {
  return {
    listCollections() {
      return Object.keys(collections)
        .sort(compareUtf8)
        .map((name) => {
          const definition = collections[name]!;
          return {
            name,
            currentSchemaVersion: currentCollectionVersion(definition),
            baseSchemaVersion: definition.migrations?.base ?? 0,
          };
        });
    },
    async validateRestoredDocument(document) {
      const definition = collections[document.collection]!;
      const stored: StoredDocument = {
        ...document.data,
        id: document.id,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        rev: document.revision,
        [TAKIBI_VERSION_KEY]: document.schemaVersion,
      };
      let current: StoredDocument;
      try {
        current = await validateStoredDocumentForRestore(definition, stored);
        assertDocumentIndexFields(definition, document.collection, current);
      } catch (error) {
        if (
          error instanceof TakibiError &&
          (error.code === "MIGRATION_VERSION" || error.code === "MIGRATION_UNAVAILABLE")
        ) {
          throw new SnapshotIncompatibleError(
            `Snapshot document version is unsupported: ${document.collection}`,
          );
        }
        throw new SnapshotInvalidDocumentError(
          `Snapshot document failed schema or index validation: ${document.collection}`,
        );
      }
      return extractUniqueConstraints(definition, document.collection, current);
    },
    async prepareSeeds() {
      const seeds: Array<{
        document: SnapshotStoredDocument;
        uniqueConstraints: SnapshotUniqueConstraint[];
      }> = [];
      const uniqueValues = new Set<string>();
      for (const collection of Object.keys(collections).sort(compareUtf8)) {
        const definition = collections[collection]!;
        if (!definition.seed) continue;
        const values = await definition.seed();
        for (const id of Object.keys(values).sort(compareUtf8)) {
          const document = await prepareAddDoc(definition, values[id], { id }, logger);
          assertDocumentIndexFields(definition, collection, document);
          for (const key of uniqueConstraintKeys(definition, collection, document)) {
            if (uniqueValues.has(key)) {
              throw new SnapshotInvalidDocumentError(
                `Unique constraint violated by collection seeds: ${collection}`,
              );
            }
            uniqueValues.add(key);
          }
          seeds.push({
            document: toSnapshotDocument(
              collection,
              currentCollectionVersion(definition),
              document,
            ),
            uniqueConstraints: extractUniqueConstraints(definition, collection, document),
          });
        }
      }
      return seeds;
    },
  };
}

function extractUniqueConstraints(
  definition: CollectionDefinition,
  collection: string,
  document: StoredDocument,
): SnapshotUniqueConstraint[] {
  const constraints: SnapshotUniqueConstraint[] = [];
  for (const [name, fields] of Object.entries(definition.unique ?? {})) {
    const values: unknown[] = [];
    let participates = true;
    for (const field of fields as readonly string[]) {
      const value = document[field];
      if (value === undefined || value === null) {
        participates = false;
        break;
      }
      if (
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
      ) {
        throw new SnapshotInvalidDocumentError(
          `${collection}: unique constraint ${name} has an invalid field`,
        );
      }
      values.push(value);
    }
    if (participates) {
      constraints.push({
        collection,
        name,
        valueKey: JSON.stringify(values),
        documentId: document.id,
      });
    }
  }
  return constraints;
}

function toSnapshotDocument(
  collection: string,
  schemaVersion: number,
  document: StoredDocument,
): SnapshotStoredDocument {
  const { id, createdAt, updatedAt, rev, [TAKIBI_VERSION_KEY]: _version, ...data } = document;
  return {
    collection,
    id,
    createdAt,
    updatedAt,
    schemaVersion,
    revision: typeof rev === "number" ? rev : 1,
    data,
  };
}

function uniqueConstraintKeys(
  definition: CollectionDefinition,
  collection: string,
  document: StoredDocument,
): string[] {
  const keys: string[] = [];
  for (const [name, fields] of Object.entries(definition.unique ?? {})) {
    const values: unknown[] = [];
    let participates = true;
    for (const field of fields as readonly string[]) {
      const value = document[field];
      if (value === undefined || value === null) {
        participates = false;
        break;
      }
      values.push(value);
    }
    if (participates) keys.push(JSON.stringify([collection, name, values]));
  }
  return keys;
}
