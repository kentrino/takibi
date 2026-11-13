import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  SqlExecutor,
  type SqlBinding,
  type SqlConnection,
  type SqlRow,
  type SqlStatementExecutor,
} from "@takibi/storage";

export type NodeSqliteExecutor = SqlExecutor & {
  close(): void;
};

/**
 * Implements the Takibi SQL port over an in-memory `node:sqlite` database.
 * One connection serves every statement; a transaction is BEGIN/COMMIT on that
 * connection. `intercept` wraps the raw connection before the executor
 * serialises it, for tests that inject faults at the port. The executor tracks
 * its transactions with `AsyncLocalStorage`, so any call on it from inside one
 * of its own open transaction callbacks rejects with `SQL_REENTRANT_CALL`
 * instead of waiting forever.
 */
export function createNodeSqliteExecutor(
  intercept?: (connection: SqlConnection) => SqlConnection,
): NodeSqliteExecutor {
  const database = new DatabaseSync(":memory:");
  let closed = false;
  const statements: SqlStatementExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      const statement = database.prepare(query);
      if (statement.columns().length === 0) {
        return { rows: [], rowsWritten: Number(statement.run(...bindings).changes) };
      }
      return { rows: statement.all(...bindings) as Row[], rowsWritten: 0 };
    },
  };
  const connection: SqlConnection = {
    ...statements,
    async transaction(body) {
      database.exec("BEGIN");
      try {
        const result = await body(statements);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        // Report the original failure even if ROLLBACK itself fails (e.g. closed database).
        if (database.isOpen && database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const executor = new SqlExecutor(intercept ? intercept(connection) : connection, {
    asyncContext: new AsyncLocalStorage(),
  });
  return Object.assign(executor, {
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}
