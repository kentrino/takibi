import { DatabaseSync } from "node:sqlite";
import type { SqlBinding, SqlExecutor, SqlRow } from "@takibi/storage";

export type NodeSqliteExecutor = SqlExecutor & {
  close(): void;
};

/**
 * Implements the Takibi SQL port over an in-memory `node:sqlite` database.
 * One connection serves every statement; a transaction is BEGIN/COMMIT on that
 * connection, so statements issued while it is open belong to it.
 */
export function createNodeSqliteExecutor(): NodeSqliteExecutor {
  const database = new DatabaseSync(":memory:");
  let closed = false;
  const executor: NodeSqliteExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      const statement = database.prepare(query);
      if (statement.columns().length === 0) {
        return { rows: [], rowsWritten: Number(statement.run(...bindings).changes) };
      }
      return { rows: statement.all(...bindings) as Row[], rowsWritten: 0 };
    },
    async transaction(callback) {
      database.exec("BEGIN");
      try {
        const result = await callback(executor);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        // Report the original failure even if ROLLBACK itself fails (e.g. closed database).
        if (database.isOpen && database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
  return executor;
}
