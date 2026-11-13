import {
  createSqliteStorage,
  type IndexRegistry,
  type SqlBinding,
  type SqlExecutor,
  type SqlRow,
  type SqliteStorageDriver,
} from "@takibi/storage";

/**
 * Minimal Durable Object adapter for this package's Workers tests. The
 * production adapter lives in `@takibi/worker-runtime`, which depends on this
 * package, so it cannot be imported here.
 */
export function durableSql(storage: DurableObjectStorage): SqlExecutor {
  const executor: SqlExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
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

export function durableStorage(
  storage: DurableObjectStorage,
  registry?: IndexRegistry,
): SqliteStorageDriver {
  return createSqliteStorage(durableSql(storage), registry);
}
