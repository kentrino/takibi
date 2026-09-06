import { compileListOptions, type ListOptions } from "@takibi/takibi-query";
import {
  AlreadyExistsError,
  LIST_ALL_MAX_ITEMS_DEFAULT,
  LIST_ALL_PAGE_SIZE_DEFAULT,
  NotFoundError,
  TakibiError,
  bindResultListAll,
  type ClientCollectionsApi,
  type CollectionDefinition,
} from "@takibi/takibi-api";
import type { DocumentId, TakibiResult, WithMetadata } from "@takibi/takibi-shared-types";
import { assertJsonObject } from "./json";
import type { InternalLogger } from "./logging";
import {
  assertRevisionPrecondition,
  documentRevision,
  nextDocumentRevision,
  takeRevisionPrecondition,
} from "./revision";
import { asTakibiResult } from "./result";
import { SchemaValidationError, parseSchema } from "./schema";
import {
  RESERVED_DOCUMENT_DATA_KEYS,
  TAKIBI_REVISION_KEY,
  TAKIBI_VERSION_KEY,
} from "@takibi/takibi-shared-types";
import type { StorageDriver } from "@takibi/takibi-storage";
import { generateUlid } from "./ulid";

const RESERVED_METADATA_KEYS = RESERVED_DOCUMENT_DATA_KEYS;

function nowIso(): string {
  return new Date().toISOString();
}

function reservedMessage(key: (typeof RESERVED_METADATA_KEYS)[number]): string {
  return `${key} is reserved and must not appear in document data`;
}

function assertNoReservedMetadataInData(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  for (const key of RESERVED_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new SchemaValidationError([{ message: reservedMessage(key), path: [key] }]);
    }
  }
}

function assertNoParsedMetadata(parsed: Record<string, unknown>): void {
  for (const key of RESERVED_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new SchemaValidationError([{ message: reservedMessage(key), path: [key] }]);
    }
  }
}

function assertDocumentOutput(value: unknown): asserts value is Record<string, unknown> {
  assertJsonObject(value, {
    subject: "Collection document",
    error: (message) => new TakibiError("INVALID_DOCUMENT", message, 500),
  });
}

function resolveDocumentId(id: unknown): DocumentId {
  if (id === undefined) return generateUlid();
  if (typeof id !== "string" || id.length === 0) {
    throw new SchemaValidationError([{ message: "id must be a non-empty string", path: ["id"] }]);
  }
  return id;
}

function asDataObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SchemaValidationError([{ message: "document data must be a plain object" }]);
  }
  return input as Record<string, unknown>;
}

function domainDataFromExisting(
  existing: WithMetadata<Record<string, unknown>>,
): Record<string, unknown> {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    [TAKIBI_REVISION_KEY]: _rev,
    [TAKIBI_VERSION_KEY]: _version,
    ...domain
  } = existing;
  return domain;
}

/** Build the document that would be stored for `add`, without collision check or put. */
export async function prepareAddDoc(
  def: CollectionDefinition,
  input: unknown,
  options?: {
    id?: DocumentId;
    createdAt?: string;
    updatedAt?: string;
  },
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  assertNoReservedMetadataInData(input);
  const parsed = await parseSchema(def.schema, input ?? {}, logger);
  assertDocumentOutput(parsed);
  assertNoParsedMetadata(parsed);
  const id = resolveDocumentId(options?.id);
  const now = nowIso();
  const createdAt = trustedTimestamp(options?.createdAt, "createdAt") ?? now;
  const updatedAt = trustedTimestamp(options?.updatedAt, "updatedAt") ?? now;
  return { ...parsed, id, createdAt, updatedAt, rev: 1 };
}

/** CREATE-only put: rejects when `doc.id` already exists. */
export async function commitAddDoc(
  storage: StorageDriver,
  collection: string,
  doc: WithMetadata<Record<string, unknown>>,
): Promise<WithMetadata<Record<string, unknown>>> {
  return storage.transaction(async (tx) => {
    const existing = await tx.get(collection, doc.id);
    if (existing) {
      throw new AlreadyExistsError(`Document already exists: ${doc.id}`);
    }
    await tx.put(collection, doc);
    return doc;
  });
}

/** Build the document that would be stored for `set`, without put. */
export async function prepareSetDoc(
  def: CollectionDefinition,
  id: string,
  input: unknown,
  existing: WithMetadata<Record<string, unknown>> | null,
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  const { data, expectedRev } = takeRevisionPrecondition(input);
  assertRevisionPrecondition(existing, expectedRev);
  assertNoReservedMetadataInData(data);
  const parsed = await parseSchema(def.schema, asDataObject(data), logger);
  assertDocumentOutput(parsed);
  assertNoParsedMetadata(parsed);
  const now = nowIso();
  const createdAt = existing?.createdAt ?? now;
  return {
    ...parsed,
    id,
    createdAt,
    updatedAt: now,
    rev: existing ? nextDocumentRevision(documentRevision(existing)) : 1,
  };
}

/** Build the document that would be stored for `update`, without put. */
export async function prepareUpdateDoc(
  def: CollectionDefinition,
  id: string,
  input: unknown,
  existing: WithMetadata<Record<string, unknown>>,
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  const { data, expectedRev } = takeRevisionPrecondition(input);
  assertRevisionPrecondition(existing, expectedRev);
  assertNoReservedMetadataInData(data);
  const merged = {
    ...domainDataFromExisting(existing),
    ...asDataObject(data),
  };
  const parsed = await parseSchema(def.schema, merged, logger);
  assertDocumentOutput(parsed);
  assertNoParsedMetadata(parsed);
  const now = nowIso();
  return {
    ...parsed,
    id,
    createdAt: existing.createdAt,
    updatedAt: now,
    rev: nextDocumentRevision(documentRevision(existing)),
  };
}

/** Trusted data-plane ops (no ACL). Used by Durable Object / admin storage. */
export async function storageAdd(
  def: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  input: unknown,
  options?: {
    id?: DocumentId;
    createdAt?: string;
    updatedAt?: string;
  },
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  const doc = await prepareAddDoc(def, input, options, logger);
  return commitAddDoc(storage, collection, doc);
}

function trustedTimestamp(
  value: string | undefined,
  field: "createdAt" | "updatedAt",
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO 8601 timestamp`);
  }
  return value;
}

export async function storageSet(
  def: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  id: string,
  input: unknown,
  options?: { existing?: WithMetadata<Record<string, unknown>> | null },
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  return storage.transaction(async (tx) => {
    const existing =
      options && "existing" in options ? options.existing : await tx.get(collection, id);
    const doc = await prepareSetDoc(def, id, input, existing ?? null, logger);
    await tx.put(collection, doc);
    return doc;
  });
}

export async function storageUpdate(
  def: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  id: string,
  input: unknown,
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  return storage.transaction(async (tx) => {
    const existing = await tx.get(collection, id);
    if (!existing) throw new NotFoundError(`Document not found: ${id}`);
    const doc = await prepareUpdateDoc(def, id, input, existing, logger);
    await tx.put(collection, doc);
    return doc;
  });
}

export async function storageDelete(
  storage: StorageDriver,
  collection: string,
  id: string,
): Promise<{ id: string }> {
  const existed = await storage.delete(collection, id);
  if (!existed) throw new NotFoundError(`Document not found: ${id}`);
  return { id };
}

export function createTypedStorage<TCollections extends Record<string, CollectionDefinition>>(
  collections: TCollections,
  driver: StorageDriver,
): ClientCollectionsApi<TCollections> {
  const api = {} as ClientCollectionsApi<TCollections>;
  for (const name of Object.keys(collections) as (keyof TCollections & string)[]) {
    const def = collections[name]!;
    api[name] = {
      add: (data, options) => asTakibiResult(() => storageAdd(def, driver, name, data, options)),
      set: (id, data) => asTakibiResult(() => storageSet(def, driver, name, id, data)),
      get: async (id): Promise<TakibiResult<WithMetadata<Record<string, unknown>>>> => {
        const doc = await driver.get(name, id);
        if (!doc) {
          return {
            ok: false,
            error: {
              kind: "operation",
              code: "NOT_FOUND",
              message: `Document not found: ${id}`,
              status: 404,
            },
          };
        }
        return { ok: true, data: doc };
      },
      update: (id, data) => asTakibiResult(() => storageUpdate(def, driver, name, id, data)),
      delete: (id) => asTakibiResult(() => storageDelete(driver, name, id)),
      list: (opts?: ListOptions) =>
        asTakibiResult(() => driver.list(name, compileListOptions(opts))),
      listAll: bindResultListAll(
        (opts?: ListOptions) => asTakibiResult(() => driver.list(name, compileListOptions(opts))),
        { pageSize: LIST_ALL_PAGE_SIZE_DEFAULT, maxItems: LIST_ALL_MAX_ITEMS_DEFAULT },
      ),
    } as ClientCollectionsApi<TCollections>[typeof name];
  }
  return api;
}
