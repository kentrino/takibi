import { ConflictError, NotFoundError } from "./errors";
import { asFireResult } from "./result";
import { SchemaValidationError, parseSchema } from "./schema";
import type {
  ClientOf,
  DocumentId,
  FireResult,
  ListOptions,
  ResourceDefinition,
  StorageDriver,
  WithId,
} from "./types";
import { generateUlid } from "./ulid";

const RESERVED_ID_MESSAGE = "id is reserved and must not appear in document data";

function assertNoReservedIdInData(input: unknown): void {
  if (
    input !== null &&
    typeof input === "object" &&
    Object.prototype.hasOwnProperty.call(input, "id")
  ) {
    throw new SchemaValidationError([{ message: RESERVED_ID_MESSAGE, path: ["id"] }]);
  }
}

function assertNoParsedId(parsed: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(parsed, "id")) {
    throw new SchemaValidationError([{ message: RESERVED_ID_MESSAGE, path: ["id"] }]);
  }
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

/** Trusted data-plane ops (no ACL). Used by Durable Object / admin storage. */
export async function storageAdd(
  def: ResourceDefinition,
  storage: StorageDriver,
  resource: string,
  input: unknown,
  options?: { id?: DocumentId },
): Promise<WithId<Record<string, unknown>>> {
  assertNoReservedIdInData(input);
  const parsed = (await parseSchema(def.schema, input ?? {})) as Record<string, unknown>;
  assertNoParsedId(parsed);
  const id = resolveDocumentId(options?.id);
  const existing = await storage.get(resource, id);
  if (existing) {
    throw new ConflictError(`Document already exists: ${id}`);
  }
  const doc = { ...parsed, id };
  await storage.put(resource, doc);
  return doc;
}

export async function storageSet(
  def: ResourceDefinition,
  storage: StorageDriver,
  resource: string,
  id: string,
  input: unknown,
): Promise<WithId<Record<string, unknown>>> {
  assertNoReservedIdInData(input);
  const parsed = (await parseSchema(def.schema, asDataObject(input))) as Record<string, unknown>;
  assertNoParsedId(parsed);
  const doc = { ...parsed, id };
  await storage.put(resource, doc);
  return doc;
}

export async function storageUpdate(
  def: ResourceDefinition,
  storage: StorageDriver,
  resource: string,
  id: string,
  input: unknown,
): Promise<WithId<Record<string, unknown>>> {
  const existing = await storage.get(resource, id);
  if (!existing) throw new NotFoundError(`Document not found: ${id}`);
  assertNoReservedIdInData(input);
  const { id: _ignored, ...existingData } = existing;
  const merged = {
    ...existingData,
    ...asDataObject(input),
  };
  const parsed = (await parseSchema(def.schema, merged)) as Record<string, unknown>;
  assertNoParsedId(parsed);
  const doc = { ...parsed, id };
  await storage.put(resource, doc);
  return doc;
}

export async function storageDelete(
  storage: StorageDriver,
  resource: string,
  id: string,
): Promise<{ id: string }> {
  const existed = await storage.delete(resource, id);
  if (!existed) throw new NotFoundError(`Document not found: ${id}`);
  return { id };
}

export function createTypedStorage<TResources extends Record<string, ResourceDefinition>>(
  resources: TResources,
  driver: StorageDriver,
): ClientOf<TResources> {
  const api = {} as ClientOf<TResources>;
  for (const name of Object.keys(resources) as (keyof TResources & string)[]) {
    const def = resources[name]!;
    api[name] = {
      add: (data, options) => asFireResult(() => storageAdd(def, driver, name, data, options)),
      set: (id, data) => asFireResult(() => storageSet(def, driver, name, id, data)),
      get: async (id): Promise<FireResult<WithId<Record<string, unknown>>>> => {
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
      update: (id, data) => asFireResult(() => storageUpdate(def, driver, name, id, data)),
      delete: (id) => asFireResult(() => storageDelete(driver, name, id)),
      list: (opts?: ListOptions) => asFireResult(() => driver.list(name, opts)),
    } as ClientOf<TResources>[typeof name];
  }
  return api;
}
