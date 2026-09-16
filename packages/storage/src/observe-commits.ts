import type { StorageDriver } from "./types";

/** Observe outside migration storage: lazy migration writes are not user commits. */
export function observeCommits(
  driver: StorageDriver,
  publish: (collections: ReadonlySet<string>) => void,
): StorageDriver {
  const notify = (collections: ReadonlySet<string>) => {
    if (!collections.size) return;
    try {
      publish(collections);
    } catch {
      /* Observers cannot change commit outcomes. */
    }
  };
  const wrap = (storage: StorageDriver, changed?: Set<string>): StorageDriver => {
    const mark = (resource: string) =>
      changed ? changed.add(resource) : notify(new Set([resource]));
    return {
      get: (resource, id) => storage.get(resource, id),
      list: (resource, options, plan) => storage.list(resource, options, plan),
      async put(resource, doc) {
        await storage.put(resource, doc);
        mark(resource);
      },
      async delete(resource, id) {
        const deleted = await storage.delete(resource, id);
        if (deleted) mark(resource);
        return deleted;
      },
      async transaction(callback) {
        // Scoped driver transactions join the outer transaction (no savepoint).
        // If a nested error is caught, its writes still belong to the outer commit.
        const pending = changed ?? new Set<string>();
        const result = await storage.transaction((scoped) => callback(wrap(scoped, pending)));
        if (!changed) notify(pending);
        return result;
      },
    };
  };
  return wrap(driver);
}
