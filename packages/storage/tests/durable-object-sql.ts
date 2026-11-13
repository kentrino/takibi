import {
  openSqliteStorage,
  SqlExecutor,
  type IndexRegistry,
  type SqlBinding,
  type SqlRow,
  type SqlStatementExecutor,
  type SqliteStorage,
} from "@takibi/storage";

/**
 * Minimal Durable Object adapter for this package's Workers tests. The
 * production adapter lives in `@takibi/worker-runtime`, which depends on this
 * package, so it cannot be imported here.
 */
function durableSql(storage: DurableObjectStorage): SqlExecutor {
  const statements: SqlStatementExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      return { rows: storage.sql.exec(query, ...bindings).toArray() as Row[] };
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
): Promise<SqliteStorage> {
  return openSqliteStorage(durableSql(storage), registry);
}
