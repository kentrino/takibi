import { TakibiError } from "@takibi/api";
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
 * What a host adapter provides for one SQLite database (Durable Object
 * storage, Node's built-in SQLite, ...). A connection needs no ordering
 * guarantees of its own; {@link SqlExecutor} serialises every use of it.
 *
 * `transaction` must invoke `body` at most once, commit when it fulfils, roll
 * back when it rejects, and never replay it. Statements `body` issues through
 * `tx` belong to that transaction.
 */
export type SqlConnection = SqlStatementExecutor & {
  transaction<T>(body: (tx: SqlStatementExecutor) => Promise<T>): Promise<T>;
};

/**
 * The SQL port the storage driver, maintenance backend, layout initialisation
 * and index reconciliation share for one database.
 *
 * Every `exec` and `transaction` call on the executor runs alone, in call
 * order: it starts only after every earlier call settled. While a transaction
 * is open, no statement reaches the connection except through that
 * transaction's `tx` handle, and two transactions never overlap. `tx` is valid
 * until the callback settles; using it afterwards rejects.
 *
 * Inside a callback, use `tx`. A call on the executor itself waits for the
 * open transaction, so awaiting it from inside the callback never settles.
 * Takibi never nests port transactions; nested storage transactions join the
 * outer one above this port.
 */
export class SqlExecutor implements SqlStatementExecutor {
  readonly #connection: SqlConnection;
  #tail: Promise<void> = Promise.resolve();

  constructor(connection: SqlConnection) {
    this.#connection = connection;
  }

  exec<Row extends SqlRow = SqlRow>(
    query: string,
    ...bindings: SqlBinding[]
  ): Promise<SqlResult<Row>> {
    return this.#serialize(() => this.#connection.exec<Row>(query, ...bindings));
  }

  transaction<T>(callback: (tx: SqlStatementExecutor) => Promise<T>): Promise<T> {
    return this.#serialize(() =>
      this.#connection.transaction(async (connectionTx) => {
        let open = true;
        const tx: SqlStatementExecutor = {
          exec(query, ...bindings) {
            if (!open) {
              return Promise.reject(
                new TakibiError(
                  "SQL_TRANSACTION_CLOSED",
                  "SQL transaction handle used after its transaction settled",
                  500,
                ),
              );
            }
            return connectionTx.exec(query, ...bindings);
          },
        };
        try {
          return await callback(tx);
        } finally {
          open = false;
        }
      }),
    );
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
