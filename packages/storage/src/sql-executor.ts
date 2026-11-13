import type { SqlBinding } from "./sql-query";

export type SqlRow = Record<string, unknown>;

export type SqlResult<Row extends SqlRow = SqlRow> = {
  /** Every result row, fully materialized. Empty for statements without result columns. */
  rows: Row[];
  /**
   * Rows written by the statement. Takibi reads it only for statements without
   * result columns (no RETURNING); adapters may report 0 for row-returning statements.
   */
  rowsWritten: number;
};

/** Runs single statements against one SQLite database. */
export type SqlStatementExecutor = {
  exec<Row extends SqlRow = SqlRow>(
    query: string,
    ...bindings: SqlBinding[]
  ): Promise<SqlResult<Row>>;
};

/**
 * The SQL execution port the Takibi storage engine runs on. Adapters translate
 * a concrete SQLite host (Durable Object storage, Node's built-in SQLite, ...)
 * into it.
 *
 * `transaction` must invoke `callback` at most once, commit when it fulfils,
 * roll back when it rejects, and never replay it. Statements belonging to the
 * transaction go through the `tx` handle passed to the callback. Takibi never
 * nests port transactions; nested storage transactions join the outer one
 * above this port.
 */
export type SqlExecutor = SqlStatementExecutor & {
  transaction<T>(callback: (tx: SqlStatementExecutor) => Promise<T>): Promise<T>;
};
