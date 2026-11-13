import { TakibiError } from "@takibi/api";
import type { SqlBinding, SqlExecutor, SqlRow } from "@takibi/storage";

/**
 * Adapts SQLite-backed Durable Object storage to the storage engine's SQL port.
 * Statements run synchronously through `storage.sql.exec` at call time; results
 * are fully materialized and delivered as an already-settled promise.
 * Transactions use `storage.transaction`, and their statements share the same
 * `storage.sql` handle.
 */
export function createDurableObjectSqlExecutor(storage: DurableObjectStorage): SqlExecutor {
  if (typeof storage.transactionSync !== "function" || storage.sql === undefined) {
    throw new TakibiError("STORAGE_BACKEND", "Takibi requires a SQLite-backed Durable Object", 500);
  }
  const executor: SqlExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      // Look up `storage.sql` on every call; never cache the bound method.
      const cursor = storage.sql.exec(query, ...bindings);
      const rows = cursor.toArray() as Row[];
      return { rows, rowsWritten: cursor.rowsWritten };
    },
    transaction(callback) {
      return storage.transaction(() => callback(executor));
    },
  };
  return executor;
}
