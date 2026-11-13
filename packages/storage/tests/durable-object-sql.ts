import {
  createSqliteStorage,
  SqlExecutor,
  type IndexRegistry,
  type SqlBinding,
  type SqlRow,
  type SqlStatementExecutor,
  type SqliteStorageDriver,
} from "@takibi/storage";

/**
 * Minimal Durable Object adapter for this package's Workers tests. The
 * production adapter lives in `@takibi/worker-runtime`, which depends on this
 * package, so it cannot be imported here.
 */
export function durableSql(storage: DurableObjectStorage): SqlExecutor {
  const statements: SqlStatementExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      const cursor = storage.sql.exec(query, ...bindings);
      return { rows: cursor.toArray() as Row[], rowsWritten: cursor.rowsWritten };
    },
  };
  return new SqlExecutor({
    ...statements,
    transaction: (body) => storage.transaction(() => body(statements)),
  });
}

export function durableStorage(
  storage: DurableObjectStorage,
  registry?: IndexRegistry,
): SqliteStorageDriver {
  return createSqliteStorage(durableSql(storage), registry);
}
