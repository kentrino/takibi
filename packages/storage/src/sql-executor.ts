import { TakibiError } from "@takibi/api";
import type { SqlBinding } from "./sql-query";

export type SqlRow = Record<string, unknown>;

export type SqlResult<Row extends SqlRow = SqlRow> = {
  /**
   * Every result row, fully materialized. Empty for statements without result
   * columns. The port carries no write count: hosts count writes differently
   * (Durable Object SQLite counts index entries too), so callers that need to
   * know what a write touched use `RETURNING`.
   */
  rows: Row[];
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
 * storage, Node's built-in SQLite, libSQL, ...). A connection needs no
 * ordering guarantees of its own; {@link SqlExecutor} serialises every use of
 * it, including statements inside one transaction, and lets `body` settle
 * only after every statement it issued settled.
 *
 * `transaction` must invoke `body` at most once, commit when it fulfils, roll
 * back when it rejects, and never replay it. Statements `body` issues through
 * `tx` belong to that transaction. When `body` rejects, `transaction` rejects
 * with that same rejection value.
 *
 * A rejection means the work did not take effect, with one exception: when
 * the connection cannot tell whether a commit took effect (the response to
 * `COMMIT`, or to an autocommit write through `exec`, was lost), it rejects
 * with {@link sqlCommitOutcomeUnknown} (`SQL_COMMIT_OUTCOME_UNKNOWN`) instead.
 * The work may or may not be durable. A connection never retries a statement
 * or a commit to find out. A connection that always knows its commit outcome
 * (a Durable Object, a local SQLite file) never raises it.
 *
 * Bindings are strings, finite numbers, and `null`. Result rows map column
 * names to `string`, `number`, or `null`. An INTEGER result outside the safe
 * integer range is backend-defined (rejected by Node's built-in SQLite and
 * libSQL, rounded to the nearest double by Durable Objects); the engine never reads
 * one, and the conformance suite pins both behaviours.
 */
export type SqlConnection = SqlStatementExecutor & {
  transaction<T>(body: (tx: SqlStatementExecutor) => Promise<T>): Promise<T>;
};

/** The {@link TakibiError} code of an unknown commit outcome. */
export const SQL_COMMIT_OUTCOME_UNKNOWN = "SQL_COMMIT_OUTCOME_UNKNOWN";

/**
 * The error a connection raises when it cannot tell whether a commit took
 * effect. Everything above the port passes it through unchanged.
 */
export function sqlCommitOutcomeUnknown(cause?: unknown): TakibiError {
  const error = new TakibiError(
    SQL_COMMIT_OUTCOME_UNKNOWN,
    "The database did not confirm whether the write was committed; it may or may not have " +
      "taken effect. Read the data again before retrying.",
    500,
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** True for the error of an unknown commit outcome. */
export function isSqlCommitOutcomeUnknown(error: unknown): boolean {
  return error instanceof TakibiError && error.code === SQL_COMMIT_OUTCOME_UNKNOWN;
}

/**
 * An async context store. Node's `AsyncLocalStorage` satisfies it; this
 * package never imports one, so hosts without async context (a Durable Object
 * without `nodejs_compat`) simply do not pass it.
 */
export interface SqlAsyncContext {
  run<R>(store: unknown, callback: () => R): R;
  getStore(): unknown;
}

export type SqlExecutorOptions = {
  /**
   * Lets the executor recognise calls made from inside one of its own
   * transaction callbacks at any depth, not only before the callback's first
   * `await`. Give each executor its own store, or share one only among
   * executors.
   */
  asyncContext?: SqlAsyncContext;
};

type OpenTransaction = { readonly executor: SqlExecutor; open: boolean };

/**
 * The SQL port the storage driver, maintenance backend, layout initialisation
 * and index reconciliation share for one database.
 *
 * Every `exec` and `transaction` call on the executor runs alone, in call
 * order: it starts only after every earlier call settled. While a transaction
 * is open, no statement reaches the connection except through that
 * transaction's `tx` handle, and two transactions never overlap. Statements on
 * `tx` also run one at a time, in call order, and the transaction commits or
 * rolls back only after every statement issued through `tx` settled, including
 * ones the callback did not await. `tx` is valid until the callback settles;
 * using it afterwards rejects.
 *
 * Inside a callback, use `tx`. A call on the executor itself would wait for
 * the open transaction, which waits for the callback: it can never settle.
 * The executor rejects such a reentrant call at once with
 * `SQL_REENTRANT_CALL` when it can tell the call comes from inside its open
 * transaction's callback:
 *
 * - always, when the call reaches the executor synchronously while the
 *   callback runs up to its first `await`;
 * - with {@link SqlExecutorOptions.asyncContext}, at any point in the
 *   callback's async continuation (including work it started without
 *   awaiting) while the transaction is open.
 *
 * Any other reentrant call (without an async context, one issued after the
 * callback's first `await`) still waits forever. Calls from independent work
 * wait for the transaction as usual. Takibi never nests port transactions;
 * nested storage transactions join the outer one above this port.
 *
 * Every rejection of the connection, including `SQL_COMMIT_OUTCOME_UNKNOWN`,
 * reaches the caller unchanged; the executor never retries.
 */
export class SqlExecutor implements SqlStatementExecutor {
  readonly #connection: SqlConnection;
  readonly #asyncContext: SqlAsyncContext | undefined;
  #tail: Promise<void> = Promise.resolve();
  /** True while a transaction callback of this executor runs synchronously. */
  #inCallback = false;

  constructor(connection: SqlConnection, options: SqlExecutorOptions = {}) {
    this.#connection = connection;
    this.#asyncContext = options.asyncContext;
  }

  exec<Row extends SqlRow = SqlRow>(
    query: string,
    ...bindings: SqlBinding[]
  ): Promise<SqlResult<Row>> {
    if (this.#isReentrant()) return Promise.reject(reentrantCallError());
    return this.#serialize(() => this.#connection.exec<Row>(query, ...bindings));
  }

  transaction<T>(callback: (tx: SqlStatementExecutor) => Promise<T>): Promise<T> {
    if (this.#isReentrant()) return Promise.reject(reentrantCallError());
    return this.#serialize(() =>
      this.#connection.transaction(async (connectionTx) => {
        const current: OpenTransaction = { executor: this, open: true };
        /** Settles once every statement issued through `tx` so far settled. */
        let statements: Promise<void> = Promise.resolve();
        const tx: SqlStatementExecutor = {
          exec<Row extends SqlRow = SqlRow>(query: string, ...bindings: SqlBinding[]) {
            if (!current.open) {
              return Promise.reject(
                new TakibiError(
                  "SQL_TRANSACTION_CLOSED",
                  "SQL transaction handle used after its transaction settled",
                  500,
                ),
              );
            }
            const result = statements.then(() => connectionTx.exec<Row>(query, ...bindings));
            statements = result.then(
              () => undefined,
              () => undefined,
            );
            return result;
          },
        };
        try {
          return await this.#enter(current, () => callback(tx));
        } finally {
          current.open = false;
          // Commit or roll back only after statements the callback left running.
          await statements;
        }
      }),
    );
  }

  /** Run the callback marked as inside `current`, synchronously and (if available) across awaits. */
  #enter<T>(current: OpenTransaction, callback: () => Promise<T>): Promise<T> {
    const invoke = () => {
      this.#inCallback = true;
      try {
        return callback();
      } finally {
        this.#inCallback = false;
      }
    };
    const context = this.#asyncContext;
    if (context === undefined) return invoke();
    const outer = context.getStore();
    const open = Array.isArray(outer) ? [...(outer as OpenTransaction[]), current] : [current];
    return context.run(open, invoke);
  }

  #isReentrant(): boolean {
    if (this.#inCallback) return true;
    const store = this.#asyncContext?.getStore();
    return (
      Array.isArray(store) &&
      (store as OpenTransaction[]).some(
        (transaction) => transaction.executor === this && transaction.open,
      )
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

function reentrantCallError(): TakibiError {
  return new TakibiError(
    "SQL_REENTRANT_CALL",
    "SQL executor called from inside its own open transaction; it would wait for that " +
      "transaction forever. Use the transaction's handle (or the transaction-scoped " +
      "storage / collections) instead.",
    500,
  );
}
