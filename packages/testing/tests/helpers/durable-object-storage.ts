import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { openSqliteStorage, type IndexRegistry, type SqliteStorage } from "@takibi/storage";
import { createDurableObjectSqlExecutor } from "@takibi/worker-runtime";

export { createDurableObjectSqlExecutor };

/** Storage engine over the production Durable Object adapter. */
export function durableSqliteStorage(
  storage: DurableObjectStorage,
  registry?: IndexRegistry,
): Promise<SqliteStorage> {
  return openSqliteStorage(createDurableObjectSqlExecutor(storage), registry);
}

/**
 * Test-only stand-in for a SQLite-backed `DurableObjectStorage`, for Node tests
 * that construct the generated Durable Object class directly or inject faults
 * through `storage.sql.exec`. Production and `@takibi/testing` code run on the
 * `SqlExecutor` port instead.
 */
export type SqliteDurableObjectStorage = DurableObjectStorage & {
  close(): void;
};

export function createSqliteDurableObjectStorage(): SqliteDurableObjectStorage {
  const database = new DatabaseSync(":memory:");
  let closed = false;
  const sql = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SQLInputValue[]) {
      const statement = database.prepare(query);
      const columnNames = statement.columns().map(({ name }) => name);
      const { rows, rowsWritten } =
        columnNames.length === 0
          ? { rows: [] as T[], rowsWritten: Number(statement.run(...bindings).changes) }
          : { rows: statement.all(...bindings) as T[], rowsWritten: 0 };
      let index = 0;
      return {
        next() {
          const value = rows[index];
          if (value === undefined) return { done: true as const };
          index += 1;
          return { done: false as const, value };
        },
        toArray: () => rows,
        one() {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0]!;
        },
        columnNames,
        rowsRead: rows.length,
        rowsWritten,
        [Symbol.iterator]() {
          return this;
        },
      };
    },
  };

  const storage = {
    sql,
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async transaction<T>(
      closure: (transaction: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> {
      database.exec("BEGIN");
      try {
        const result = await closure(storage as unknown as DurableObjectTransaction);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
  return storage as unknown as SqliteDurableObjectStorage;
}
