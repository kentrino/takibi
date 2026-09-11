import { DatabaseSync, type SQLInputValue } from "node:sqlite";

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
      const result =
        columnNames.length === 0
          ? { rows: [] as T[], rowsWritten: Number(statement.run(...bindings).changes) }
          : { rows: statement.all(...bindings) as T[], rowsWritten: 0 };
      const { rows, rowsWritten } = result;
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
        *raw<U extends SqlStorageValue[]>() {
          for (const row of rows) {
            yield columnNames.map((column) => row[column]) as U;
          }
        },
        columnNames,
        rowsRead: rows.length,
        rowsWritten,
        [Symbol.iterator]() {
          return this;
        },
      };
    },
    get databaseSize() {
      const pageCount = database.prepare("PRAGMA page_count").get() as { page_count: number };
      const pageSize = database.prepare("PRAGMA page_size").get() as { page_size: number };
      return pageCount.page_count * pageSize.page_size;
    },
  };

  const storage = {
    sql,
    async deleteAll(): Promise<void> {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      database.exec("PRAGMA foreign_keys = OFF");
      try {
        for (const { name } of tables) {
          database.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
        }
      } finally {
        database.exec("PRAGMA foreign_keys = ON");
      }
    },
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
