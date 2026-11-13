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
 * Where the database lives, which decides whether a failed write can leave
 * its commit outcome unknown.
 *
 * - `local`: a file or `:memory:` opened in process. A failed statement or
 *   commit was rolled back; the outcome is always known.
 * - `remote`: a libSQL server reached over HTTP (Turso, `sqld`). A response
 *   can be lost after the server committed.
 */
export type LibsqlLocation = "local" | "remote";

/**
 * True when a failed remote write certainly did not commit. Everything else
 * is reported as an unknown outcome, so this must only ever err towards
 * `false`.
 *
 * It relies only on the client's public error surface (`LibsqlError` and its
 * `code`, exported by `@libsql/client`):
 *
 * - `SQLITE_*`: the server's SQLite rejected the statement (a constraint,
 *   `SQLITE_BUSY`, ...), so it did not take effect. libSQL servers report
 *   SQLite result codes under their names; `sqld` 0.24.32 does, as the
 *   remote integration test shows.
 * - `TRANSACTION_CLOSED`: the client refused to send `COMMIT` because the
 *   transaction was already closed.
 *
 * Transport failures never carry such a code: a failed `fetch` is not a
 * `LibsqlError` at all, and an HTTP error status, a protocol error or a
 * closed stream map to `SERVER_ERROR`, `HRANA_PROTO_ERROR`,
 * `HRANA_CLOSED_ERROR` or `UNKNOWN` (checked for `@libsql/client` 0.18.0;
 * `tests/connection.test.ts` pins the version). Server errors that are not
 * SQLite result codes (`SQL_PARSE_ERROR`, a stream timeout, ...) are treated
 * as unknown too: rare for the engine's statements, and safe.
 */
export function remoteFailureProvesNotCommitted(error: unknown): boolean {
  return (
    error instanceof LibsqlError &&
    (error.code.startsWith("SQLITE_") || error.code === "TRANSACTION_CLOSED")
  );
}

/**
 * A {@link SqlConnection} over a libSQL client. The client must use
 * `intMode: "number"`, and a local one exactly one connection
 * (`concurrency: 1`) so per-connection pragmas apply to every statement;
 * {@link openLibsqlConnection} creates it that way. A remote client may also
 * be created by the caller (for example `@libsql/client/web` inside a
 * Cloudflare Worker) and passed with `location: "remote"`.
 *
 * On a remote database, a failed `exec` (an autocommit statement that may
 * write) or a failed `COMMIT` rejects with `SQL_COMMIT_OUTCOME_UNKNOWN`
 * unless {@link remoteFailureProvesNotCommitted}. A failed `read` or a failed
 * statement inside a transaction is an ordinary rejection: neither commits
 * anything. Nothing here, nor in the client (checked for 0.18.0), retries a
 * statement or a commit.
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
  /** Rethrow a failed write as itself, or as an unknown outcome when it may have committed. */
  const classify = (error: unknown): unknown =>
    location === "local" || remoteFailureProvesNotCommitted(error)
      ? error
      : sqlCommitOutcomeUnknown(error);
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
        // An autocommit statement that may write commits on its own.
        throw classify(error);
      }
    },
    async read<Row extends SqlRow>(query: string, ...bindings: SqlBinding[]) {
      assertOpen();
      return run<Row>(client, query, bindings);
    },
    async transaction(body) {
      assertOpen();
      // `write` mode starts with BEGIN IMMEDIATE.
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
          throw classify(error);
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
