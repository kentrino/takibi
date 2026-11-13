import { TakibiError } from "@takibi/api";
import {
  SqlExecutor,
  type SqlBinding,
  type SqlRow,
  type SqlStatementExecutor,
} from "@takibi/storage";

/**
 * Adapts SQLite-backed Durable Object storage to the storage engine's SQL port.
 * Each statement runs synchronously through `storage.sql.exec` when the
 * executor reaches it; results are fully materialized. Transactions use
 * `storage.transaction`. The returned executor serialises every statement and
 * transaction, so a statement issued outside an open transaction waits for it
 * instead of joining it.
 */
export function createDurableObjectSqlExecutor(storage: DurableObjectStorage): SqlExecutor {
  if (typeof storage.transactionSync !== "function" || storage.sql === undefined) {
    throw new TakibiError("STORAGE_BACKEND", "Takibi requires a SQLite-backed Durable Object", 500);
  }
  const statements: SqlStatementExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      // Look up `storage.sql` on every call; never cache the bound method.
      return { rows: storage.sql.exec(query, ...bindings).toArray() as Row[] };
    },
  };
  return new SqlExecutor({
    ...statements,
    transaction: (body) => storage.transaction(() => body(statements)),
  });
}
