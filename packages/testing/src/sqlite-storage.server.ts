import { AsyncLocalStorage } from "node:async_hooks";
import { openNodeSqliteConnection } from "@takibi/node-sqlite";
import { SqlExecutor, type SqlConnection } from "@takibi/storage";

export type NodeSqliteExecutor = SqlExecutor & {
  close(): void;
};

/**
 * The Takibi SQL port over a private in-memory `node:sqlite` database, opened
 * with the production connection of `@takibi/node-sqlite`. `intercept` wraps
 * the raw connection before the executor serialises it, for tests that inject
 * faults at the port. The executor tracks its transactions with
 * `AsyncLocalStorage`, so any call on it from inside one of its own open
 * transaction callbacks rejects with `SQL_REENTRANT_CALL` instead of waiting
 * forever.
 */
export function createNodeSqliteExecutor(
  intercept?: (connection: SqlConnection) => SqlConnection,
): NodeSqliteExecutor {
  const connection = openNodeSqliteConnection(":memory:");
  const executor = new SqlExecutor(intercept ? intercept(connection) : connection, {
    asyncContext: new AsyncLocalStorage(),
  });
  return Object.assign(executor, { close: () => connection.close() });
}
