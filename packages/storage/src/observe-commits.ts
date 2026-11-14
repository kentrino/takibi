import { isSqlCommitOutcomeUnknown } from "./sql-executor";
import type { StorageDriver } from "./types";

/**
 * Observe outside migration storage: lazy migration writes are not user commits.
 *
 * A write that rolled back publishes nothing. A write whose commit outcome is
 * unknown (`SQL_COMMIT_OUTCOME_UNKNOWN`) may have taken effect, so it publishes
 * the collections it touched before the error propagates: observers re-read
 * rather than miss a committed change.
 */
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
    const markIfUnknown = (resource: string, error: unknown) => {
      if (isSqlCommitOutcomeUnknown(error)) mark(resource);
    };
    return {
      get: (resource, id) => storage.get(resource, id),
      list: (resource, options, plan) => storage.list(resource, options, plan),
      async put(resource, doc) {
        try {
          await storage.put(resource, doc);
        } catch (error) {
          markIfUnknown(resource, error);
          throw error;
        }
        mark(resource);
      },
      async delete(resource, id) {
        let deleted: boolean;
        try {
          deleted = await storage.delete(resource, id);
        } catch (error) {
          markIfUnknown(resource, error);
          throw error;
        }
        if (deleted) mark(resource);
        return deleted;
      },
      async transaction(callback) {
        // Scoped driver transactions join the outer transaction (no savepoint).
        // If a nested error is caught, its writes still belong to the outer commit.
        const pending = changed ?? new Set<string>();
        try {
          const result = await storage.transaction((scoped) => callback(wrap(scoped, pending)));
          if (!changed) notify(pending);
          return result;
        } catch (error) {
          if (!changed && isSqlCommitOutcomeUnknown(error)) notify(pending);
          throw error;
        }
      },
    };
  };
  return wrap(driver);
}
