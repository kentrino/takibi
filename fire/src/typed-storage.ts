import { NotFoundError } from "./errors";
import { parseSchema } from "./schema";
import type { ClientOf, ListOptions, ResourceDefinition, StorageDriver, WithId } from "./types";
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
      add: (data) => storageAdd(def, driver, name, data),
      set: (id, data) => storageSet(def, driver, name, id, data),
      get: (id) => driver.get(name, id),
      update: (id, data) => storageUpdate(def, driver, name, id, data),
      delete: (id) => storageDelete(driver, name, id),
      list: (opts?: ListOptions) => driver.list(name, opts),
    } as ClientOf<TResources>[typeof name];
  }
  return api;
}
