import { AlreadyExistsError, NotFoundError, StaleWriteError, TakibiError } from "./errors";
import { assertJsonObject } from "./json";
import { compileListOptions } from "./query";
import { documentRevision, takeRevisionPrecondition } from "./revision";
import { asTakibiResult } from "./result";
import { SchemaValidationError, parseSchema } from "./schema";
import { RESERVED_DOCUMENT_DATA_KEYS, TAKIBI_REVISION_KEY, TAKIBI_VERSION_KEY } from "./types";
import type {
  ClientCollectionsApi,
  CollectionDefinition,
  DocumentId,
  TakibiResult,
  ListOptions,
  StorageDriver,
  WithMetadata,
} from "./types";
import { generateUlid } from "./ulid";

const RESERVED_METADATA_KEYS = RESERVED_DOCUMENT_DATA_KEYS;

type Clock = () => Date;

/** Production clock: wall time via `new Date()`. Overridable in tests. */
let clock: Clock = () => new Date();

/** Replace the write-path clock. Pass `undefined` to restore `new Date()`. Tests only. */
export function setClockForTests(next: Clock | undefined): void {
  clock = next ?? (() => new Date());
}

function nowIso(): string {
  return clock().toISOString();
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
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
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
  options?: { id?: DocumentId },
): Promise<WithMetadata<Record<string, unknown>>> {
  assertNoReservedMetadataInData(input);
  const parsed = await parseSchema(def.schema, input ?? {});
  assertDocumentOutput(parsed);
  assertNoParsedMetadata(parsed);
  const id = resolveDocumentId(options?.id);
  const now = nowIso();
  return { ...parsed, id, createdAt: now, updatedAt: now, rev: 1 };
}

/** CREATE-only put: rejects when `doc.id` already exists. */
export async function commitAddDoc(
  storage: StorageDriver,
  collection: string,
  doc: WithMetadata<Record<string, unknown>>,
): Promise<WithMetadata<Record<string, unknown>>> {
  const existing = await storage.get(collection, doc.id);
  if (existing) {
    throw new AlreadyExistsError(`Document already exists: ${doc.id}`);
  }
  await storage.put(collection, doc);
  return doc;
}

/** Build the document that would be stored for `set`, without put. */
export async function prepareSetDoc(
  def: CollectionDefinition,
  id: string,
  input: unknown,
  existing: WithMetadata<Record<string, unknown>> | null,
): Promise<WithMetadata<Record<string, unknown>>> {
  const { data, expectedRev } = takeRevisionPrecondition(input);
  assertRevisionPrecondition(existing, expectedRev);
  assertNoReservedMetadataInData(data);
  const parsed = await parseSchema(def.schema, asDataObject(data));
  assertDocumentOutput(parsed);
  assertNoParsedMetadata(parsed);
  const now = nowIso();
  const createdAt = existing?.createdAt ?? now;
  return {
    ...parsed,
    id,
    createdAt,
    updatedAt: now,
    rev: existing ? documentRevision(existing) + 1 : 1,
  };
}

/** Build the document that would be stored for `update`, without put. */
export async function prepareUpdateDoc(
  def: CollectionDefinition,
  id: string,
  input: unknown,
  existing: WithMetadata<Record<string, unknown>>,
): Promise<WithMetadata<Record<string, unknown>>> {
  const { data, expectedRev } = takeRevisionPrecondition(input);
  assertRevisionPrecondition(existing, expectedRev);
  assertNoReservedMetadataInData(data);
  const merged = {
    ...domainDataFromExisting(existing),
    ...asDataObject(data),
  };
  const parsed = await parseSchema(def.schema, merged);
  assertDocumentOutput(parsed);
  assertNoParsedMetadata(parsed);
  const now = nowIso();
  return {
    ...parsed,
    id,
    createdAt: existing.createdAt,
    updatedAt: now,
    rev: documentRevision(existing) + 1,
  };
}

function assertRevisionPrecondition(
  existing: WithMetadata<Record<string, unknown>> | null,
  expectedRev: number | undefined,
): void {
  if (expectedRev === undefined) return;
  if (!existing || documentRevision(existing) !== expectedRev) {
    throw new StaleWriteError();
  }
}

/** Trusted data-plane ops (no ACL). Used by Durable Object / admin storage. */
export async function storageAdd(
  def: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  input: unknown,
  options?: { id?: DocumentId },
): Promise<WithMetadata<Record<string, unknown>>> {
  const doc = await prepareAddDoc(def, input, options);
  return commitAddDoc(storage, collection, doc);
}

export async function storageSet(
  def: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  id: string,
  input: unknown,
  options?: { existing?: WithMetadata<Record<string, unknown>> | null },
): Promise<WithMetadata<Record<string, unknown>>> {
  const existing =
    options && "existing" in options ? options.existing : await storage.get(collection, id);
  const doc = await prepareSetDoc(def, id, input, existing ?? null);
  await storage.put(collection, doc);
  return doc;
}

export async function storageUpdate(
  def: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  id: string,
  input: unknown,
): Promise<WithMetadata<Record<string, unknown>>> {
  const existing = await storage.get(collection, id);
  if (!existing) throw new NotFoundError(`Document not found: ${id}`);
  const doc = await prepareUpdateDoc(def, id, input, existing);
  await storage.put(collection, doc);
  return doc;
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
    } as ClientCollectionsApi<TCollections>[typeof name];
  }
  return api;
}
