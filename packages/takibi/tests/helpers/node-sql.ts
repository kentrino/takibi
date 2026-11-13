import type { SqlBinding, SqlConnection, SqlRow, SqlStatementExecutor } from "@takibi/storage";

/** Every row of one statement. */
export async function all<Row extends SqlRow = SqlRow>(
  sql: SqlStatementExecutor,
  query: string,
  ...bindings: SqlBinding[]
): Promise<Row[]> {
  return (await sql.exec<Row>(query, ...bindings)).rows;
}

/** Exactly one row of one statement, like a Durable Object cursor's `one()`. */
export async function one<Row extends SqlRow = SqlRow>(
  sql: SqlStatementExecutor,
  query: string,
  ...bindings: SqlBinding[]
): Promise<Row> {
  const rows = await all<Row>(sql, query, ...bindings);
  if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
  return rows[0]!;
}

/**
 * Connection interceptor for `createNodeSqliteExecutor`: calls `observe` with
 * every statement, inside or outside a transaction, before it runs. Throwing
 * from `observe` fails that statement.
 */
export function onStatement(
  observe: (query: string) => void,
): (connection: SqlConnection) => SqlConnection {
  const watched = (executor: SqlStatementExecutor): SqlStatementExecutor => ({
    async exec(query, ...bindings) {
      observe(query);
      return executor.exec(query, ...bindings);
    },
  });
  return (connection) => ({
    ...watched(connection),
    transaction: (body) => connection.transaction((tx) => body(watched(tx))),
  });
}
