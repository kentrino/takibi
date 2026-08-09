import type { ListOptions, StorageDriver, WithId } from "./types";

export function createMemoryStorage(): StorageDriver {
  const tables = new Map<string, Map<string, WithId<Record<string, unknown>>>>();

  const table = (resource: string) => {
    let t = tables.get(resource);
    if (!t) {
      t = new Map();
      tables.set(resource, t);
    }
    return t;
  };

  return {
    async get(resource, id) {
      return table(resource).get(id) ?? null;
    },
    async put(resource, doc) {
      table(resource).set(doc.id, structuredClone(doc));
    },
    async delete(resource, id) {
      return table(resource).delete(id);
    },
    async list(resource, opts) {
      return paginate([...table(resource).values()], opts);
    },
  };
}

export function createDurableObjectStorage(storage: DurableObjectStorage): StorageDriver {
  const keyOf = (resource: string, id: string) => `fire:${resource}:${id}`;
  const prefixOf = (resource: string) => `fire:${resource}:`;

  return {
    async get(resource, id) {
      return (await storage.get<WithId<Record<string, unknown>>>(keyOf(resource, id))) ?? null;
    },
    async put(resource, doc) {
      await storage.put(keyOf(resource, doc.id), doc);
    },
    async delete(resource, id) {
      return storage.delete(keyOf(resource, id));
    },
    async list(resource, opts) {
      const prefix = prefixOf(resource);
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
      const result = await storage.list<WithId<Record<string, unknown>>>({
        prefix,
        limit: limit + 1,
        startAfter: opts?.cursor ? keyOf(resource, opts.cursor) : undefined,
      });
      const items = [...result.values()];
      if (items.length > limit) {
        const page = items.slice(0, limit);
        return { items: page, nextCursor: page.at(-1)?.id };
      }
      return { items };
    },
  };
}

function paginate(
  items: WithId<Record<string, unknown>>[],
  opts?: ListOptions,
): { items: WithId<Record<string, unknown>>[]; nextCursor?: string } {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  let start = 0;
  if (opts?.cursor) {
    const idx = sorted.findIndex((d) => d.id === opts.cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = sorted.slice(start, start + limit);
  const next = sorted[start + limit];
  return next ? { items: page, nextCursor: page.at(-1)?.id } : { items: page };
}
