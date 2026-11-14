import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { TakibiError } from "@takibi/api";
import {
  SqlExecutor,
  type SqlBinding,
  type SqlConnection,
  type SqlRow,
  type SqlStatementExecutor,
} from "@takibi/storage";

export type NodeSqliteOptions = {
  /**
   * How long a statement waits for a lock held by another connection, in
   * milliseconds. Default `0`: fail at once with `SQLITE_BUSY`. `node:sqlite`
   * is synchronous, so waiting blocks the whole process, and with one owner
   * per database a lock held elsewhere is an operational error, not
   * contention to wait out.
   */
  busyTimeoutMs?: number;
};

/** One tenant database opened with `node:sqlite`. */
export type NodeSqliteConnection = SqlConnection & {
  /** The path (or `:memory:`) the connection was opened with. */
  readonly location: string;
  /** Close the database. Idempotent; later calls reject with `SQL_CONNECTION_CLOSED`. */
  close(): void;
};

/** A {@link SqlExecutor} over its own {@link NodeSqliteConnection}. */
export type NodeSqliteExecutor = SqlExecutor & {
  readonly location: string;
  /** Close the database. Call it only after every use of the executor settled. */
  close(): void;
};

const MEMORY = ":memory:";
const STATEMENT_CACHE_SIZE = 256;

/**
 * Open (creating if missing) the SQLite database at `location`, or a private
 * in-memory database for `":memory:"`, as a Takibi SQL connection.
 *
 * Exactly one connection in one process may write a tenant database; the
 * host enforces that. A file database is configured for that owner:
 *
 * - `journal_mode=WAL`: commits append to the write-ahead log, and readers
 *   such as a backup tool never block the owner. Opening fails if WAL cannot
 *   be enabled (for example on a file system without shared memory).
 * - `synchronous=FULL`: a commit is durable once acknowledged, also across
 *   power loss, as on a Durable Object. A crash mid-transaction leaves
 *   nothing of it: the next open rolls it back from the log. Keep the
 *   `-wal` and `-shm` files with the database file.
 * - `busy_timeout` from {@link NodeSqliteOptions.busyTimeoutMs}.
 * - `foreign_keys=ON`, as on a Durable Object (Takibi's own tables declare none).
 *
 * Transactions start with `BEGIN IMMEDIATE`, so a transaction holds the write
 * lock from its first statement and never fails later to upgrade a read lock.
 * A local database always knows its commit outcome: a failed `COMMIT` is
 * rolled back and reported as a failure.
 *
 * Bindings and results follow the SQL port: JavaScript numbers bind as
 * SQLite REAL values; an INTEGER result outside the safe integer range
 * rejects instead of losing precision.
 */
export function openNodeSqliteConnection(
  location: string,
  options: NodeSqliteOptions = {},
): NodeSqliteConnection {
  const database = new DatabaseSync(location);
  try {
    configure(database, location, options);
  } catch (error) {
    database.close();
    throw error;
  }

  const cache = new Map<string, { statement: StatementSync; returnsRows: boolean }>();
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new TakibiError("SQL_CONNECTION_CLOSED", "The SQLite connection is closed", 500);
    }
  };
  const prepare = (query: string) => {
    const cached = cache.get(query);
    if (cached !== undefined) {
      // Refresh the entry: the map's insertion order is its eviction order.
      cache.delete(query);
      cache.set(query, cached);
      return cached;
    }
    const statement = database.prepare(query);
    const entry = { statement, returnsRows: statement.columns().length > 0 };
    cache.set(query, entry);
    if (cache.size > STATEMENT_CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return entry;
  };
  const statements: SqlStatementExecutor = {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      assertOpen();
      const { statement, returnsRows } = prepare(query);
      if (!returnsRows) {
        statement.run(...bindings);
        return { rows: [] };
      }
      return { rows: statement.all(...bindings) as Row[] };
    },
  };
  return {
    location,
    ...statements,
    async transaction(body) {
      assertOpen();
      database.exec("BEGIN IMMEDIATE");
      let result: Awaited<ReturnType<typeof body>>;
      try {
        result = await body(statements);
      } catch (error) {
        rollback(database);
        throw error;
      }
      try {
        database.exec("COMMIT");
      } catch (error) {
        // A failed COMMIT (SQLITE_BUSY) can leave the transaction open.
        rollback(database);
        throw error;
      }
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      // Closing with a transaction open rolls it back.
      database.close();
    },
  };
}

/**
 * {@link openNodeSqliteConnection} behind its own {@link SqlExecutor}, which
 * tracks open transactions with `AsyncLocalStorage`: a call on the executor
 * from anywhere inside one of its own transaction callbacks rejects with
 * `SQL_REENTRANT_CALL` instead of waiting forever.
 */
export function openNodeSqliteExecutor(
  location: string,
  options: NodeSqliteOptions = {},
): NodeSqliteExecutor {
  const connection = openNodeSqliteConnection(location, options);
  const executor = new SqlExecutor(connection, { asyncContext: new AsyncLocalStorage() });
  return Object.assign(executor, {
    location: connection.location,
    close: () => connection.close(),
  });
}

function configure(database: DatabaseSync, location: string, options: NodeSqliteOptions): void {
  const busyTimeout = options.busyTimeoutMs ?? 0;
  if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
    throw new TypeError("busyTimeoutMs must be a non-negative integer");
  }
  database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  database.exec("PRAGMA foreign_keys = ON");
  if (location === MEMORY) return;
  const mode = database.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: unknown };
  if (mode.journal_mode !== "wal") {
    throw new TakibiError(
      "STORAGE_BACKEND",
      `Could not enable WAL mode for ${location} (journal_mode is ${String(mode.journal_mode)})`,
      500,
    );
  }
  database.exec("PRAGMA synchronous = FULL");
}

function rollback(database: DatabaseSync): void {
  // Report the original failure even if ROLLBACK itself fails.
  try {
    if (database.isOpen && database.isTransaction) database.exec("ROLLBACK");
  } catch {
    /* The original error is the one to report. */
  }
}
