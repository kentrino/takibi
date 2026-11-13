import { LibsqlError, type Client, type Transaction } from "@libsql/client";
import { TakibiError } from "@takibi/api";
import {
  sqlCommitOutcomeUnknown,
  type SqlBinding,
  type SqlConnection,
  type SqlRow,
  type SqlStatementExecutor,
} from "@takibi/storage";

/**
 * Where the database lives, which decides whether a failure can leave a
 * commit's outcome unknown.
 *
 * - `local`: a file or `:memory:` opened in process. A failed commit was
 *   rolled back; the outcome is always known.
 * - `remote`: a `libsql:`, `http(s):` or `ws(s):` URL. A response can be lost.
 * - `replica`: a local file with `syncUrl` (embedded replica). Writes go to
 *   the primary unless offline writes are enabled, so a response can be lost.
 */
export type LibsqlLocation = "local" | "remote" | "replica";

/** Error codes the client raises before it sends anything to the database. */
const NOT_SENT = new Set(["TRANSACTION_CLOSED", "CLIENT_CLOSED", "TRANSACTION_ACTIVE"]);

/**
 * True when `error` proves the database answered (or was never asked), so
 * the write it failed certainly did not take effect.
 *
 * Remote errors carry the server's response as a hrana `ResponseError` cause;
 * any other failure (a dropped connection, a fetch error, an HTTP 5xx, a
 * protocol error) may have happened after the server committed. Local and
 * replica statements fail with SQLite result codes (`SQLITE_*`) when the
 * engine rejected them.
 */
export function provesNotCommitted(location: LibsqlLocation, error: unknown): boolean {
  if (location === "local") return true;
  if (!(error instanceof LibsqlError)) return false;
  if (NOT_SENT.has(error.code)) return true;
  if (location === "remote") {
    return error.cause instanceof Error && error.cause.name === "ResponseError";
  }
  return error.code.startsWith("SQLITE_");
}

/** Rethrow a failed write as itself, or as an unknown commit outcome when it may have committed. */
function classify(location: LibsqlLocation, error: unknown): unknown {
  return provesNotCommitted(location, error) ? error : sqlCommitOutcomeUnknown(error);
}

/**
 * A {@link SqlConnection} over a libSQL client. The client must use
 * `intMode: "number"` and, for a local or replica database, exactly one
 * connection (`concurrency: 1`), so per-connection pragmas apply to every
 * statement; {@link openLibsqlConnection} creates it that way.
 */
export function libsqlConnection(
  client: Client,
  location: LibsqlLocation,
): SqlConnection & { close(): void } {
  let closed = false;
  const assertOpen = () => {
    if (closed) {
      throw new TakibiError("SQL_CONNECTION_CLOSED", "The libSQL connection is closed", 500);
    }
  };
  const run = async <Row extends SqlRow>(
    target: Client | Transaction,
    query: string,
    bindings: SqlBinding[],
  ): Promise<{ rows: Row[] }> => {
    const result = await target.execute({ sql: query, args: bindings });
    // Rows carry non-enumerable positional properties; keep the named columns.
    return { rows: result.rows.map((row) => ({ ...row }) as unknown as Row) };
  };
  return {
    async exec<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      assertOpen();
      try {
        return await run<Row>(client, query, bindings);
      } catch (error) {
        // An autocommit statement commits on its own.
        throw classify(location, error);
      }
    },
    async transaction(body) {
      assertOpen();
      // `write` mode starts with BEGIN IMMEDIATE. Nothing here, nor in the
      // client (checked for @libsql/client 0.18.0), retries a statement or a
      // commit.
      const transaction = await client.transaction("write");
      const tx: SqlStatementExecutor = {
        // Inside a transaction nothing commits per statement: a lost
        // response leaves the transaction uncommitted.
        exec: <Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) =>
          run<Row>(transaction, query, bindings),
      };
      try {
        let result: Awaited<ReturnType<typeof body>>;
        try {
          result = await body(tx);
        } catch (error) {
          await transaction.rollback().catch(() => undefined);
          throw error;
        }
        try {
          await transaction.commit();
        } catch (error) {
          throw classify(location, error);
        }
        return result;
      } finally {
        transaction.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      client.close();
    },
  };
}
