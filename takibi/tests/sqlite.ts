import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export function createSqliteDurableObjectStorage(): DurableObjectStorage {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SQLInputValue[]) {
      const statement = database.prepare(query);
      const rows = statement.all(...bindings) as T[];
      const columnNames = statement.columns().map(({ name }) => name);
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
        rowsWritten: 0,
        [Symbol.iterator]() {
          return this;
        },
      };
    },
    get databaseSize() {
      return 0;
    },
  };

  return {
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
  } as unknown as DurableObjectStorage;
}
