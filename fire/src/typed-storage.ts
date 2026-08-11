import { NotFoundError } from "./errors";
import { asFireResult } from "./result";
import { parseSchema } from "./schema";
import type {
  ClientOf,
  FireResult,
  ListOptions,
  ResourceDefinition,
  StorageDriver,
  WithId,
} from "./types";
import { generateUlid } from "./ulid";

/** Trusted data-plane ops (no ACL). Used by Durable Object / admin storage. */
export async function storageAdd(
  def: ResourceDefinition,
  storage: StorageDriver,
  resource: string,
  input: unknown,
): Promise<WithId<Record<string, unknown>>> {
  const parsed = (await parseSchema(def.schema, input ?? {})) as Record<string, unknown>;
  const id = typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : generateUlid();
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
  const parsed = (await parseSchema(def.schema, {
    ...(typeof input === "object" && input !== null ? input : {}),
    id,
  })) as Record<string, unknown>;
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
  const merged = {
    ...existing,
    ...(typeof input === "object" && input !== null ? input : {}),
    id,
  };
  const parsed = (await parseSchema(def.schema, merged)) as Record<string, unknown>;
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
      add: (data) => asFireResult(() => storageAdd(def, driver, name, data)),
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
