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
 * transaction's `tx` handle, and two transactions never overlap. `tx` is valid
 * until the callback settles; using it afterwards rejects.
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
        const tx: SqlStatementExecutor = {
          exec(query, ...bindings) {
            if (!current.open) {
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
          return await this.#enter(current, () => callback(tx));
        } finally {
          current.open = false;
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
