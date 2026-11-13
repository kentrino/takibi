import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type Config } from "@libsql/client";
import { TakibiError } from "@takibi/api";
import { SqlExecutor, type SqlConnection } from "@takibi/storage";
import { libsqlConnection, type LibsqlLocation } from "./connection";

export type { LibsqlLocation } from "./connection";

/**
 * libSQL client configuration, minus what the connection decides itself:
 * integers are read as numbers (an unsafe integer rejects) and a local or
 * replica database gets exactly one connection.
 */
export type LibsqlConnectionConfig = Omit<Config, "intMode" | "concurrency">;

/** One tenant database opened through the libSQL client. */
export type LibsqlConnection = SqlConnection & {
  readonly location: LibsqlLocation;
  /** Close the client. Idempotent; later calls reject with `SQL_CONNECTION_CLOSED`. */
  close(): void;
};

/** A {@link SqlExecutor} over its own {@link LibsqlConnection}. */
export type LibsqlExecutor = SqlExecutor & {
  readonly location: LibsqlLocation;
  /** Close the client. Call it only after every use of the executor settled. */
  close(): void;
};

/**
 * Open one tenant's libSQL database as a Takibi SQL connection: a local file
 * or `:memory:`, an embedded replica (a file plus `syncUrl`), or a remote
 * `libsql:` / `http(s):` / `ws(s):` URL (one Turso database per tenant).
 *
 * A local file is configured like `@takibi/node-sqlite`: WAL,
 * `synchronous=FULL`, `foreign_keys=ON`; the busy timeout is the client's
 * `timeout` option (default 0). Replica and remote databases are left as the
 * server or replica configures them.
 *
 * Transactions use the client's `write` mode (`BEGIN IMMEDIATE`). Against a
 * remote database every statement is a network round trip and an open
 * transaction holds the server's write lock across them. When a remote or
 * replica commit (or autocommit write) fails without proof that it did not
 * take effect, the connection rejects with `SQL_COMMIT_OUTCOME_UNKNOWN`.
 *
 * Only local files and `:memory:` are covered by tests; remote and replica
 * behaviour follows the client's source (`@libsql/client` 0.18.0) and is
 * unverified here.
 */
export async function openLibsqlConnection(
  config: LibsqlConnectionConfig,
): Promise<LibsqlConnection> {
  const location = locationOf(config);
  const client = createClient({
    ...config,
    intMode: "number",
    // One connection, so per-connection pragmas cover every statement. The
    // executor serialises all use anyway.
    concurrency: 1,
  });
  const connection = libsqlConnection(client, location);
  try {
    if (location === "local") await configureLocal(connection, config.url);
  } catch (error) {
    connection.close();
    throw error;
  }
  return Object.assign(connection, { location });
}

/**
 * {@link openLibsqlConnection} behind its own {@link SqlExecutor}, which
 * tracks open transactions with `AsyncLocalStorage`: a call on the executor
 * from anywhere inside one of its own transaction callbacks rejects with
 * `SQL_REENTRANT_CALL` instead of waiting forever.
 */
export async function openLibsqlExecutor(config: LibsqlConnectionConfig): Promise<LibsqlExecutor> {
  const connection = await openLibsqlConnection(config);
  const executor = new SqlExecutor(connection, { asyncContext: new AsyncLocalStorage() });
  return Object.assign(executor, {
    location: connection.location,
    close: () => connection.close(),
  });
}

function locationOf(config: LibsqlConnectionConfig): LibsqlLocation {
  const url = config.url.trim();
  const local = url === ":memory:" || url.startsWith("file:");
  if (!local) return "remote";
  return config.syncUrl === undefined ? "local" : "replica";
}

function isMemory(url: string): boolean {
  return url === ":memory:" || url.startsWith("file::memory:");
}

async function configureLocal(connection: SqlConnection, url: string): Promise<void> {
  await connection.exec("PRAGMA foreign_keys = ON");
  if (isMemory(url)) return;
  const mode = (await connection.exec<{ journal_mode?: unknown }>("PRAGMA journal_mode = WAL"))
    .rows[0];
  if (mode?.journal_mode !== "wal") {
    throw new TakibiError(
      "STORAGE_BACKEND",
      `Could not enable WAL mode for ${url} (journal_mode is ${String(mode?.journal_mode)})`,
      500,
    );
  }
  await connection.exec("PRAGMA synchronous = FULL");
}
