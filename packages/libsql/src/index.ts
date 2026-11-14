import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@libsql/client";
import { TakibiError } from "@takibi/api";
import { SqlExecutor, type SqlConnection } from "@takibi/storage";
import { libsqlConnection, type LibsqlLocation } from "./connection";

export { libsqlConnection } from "./connection";
export type { LibsqlLocation } from "./connection";

/**
 * Which tenant database to open. Everything else the client offers is
 * decided here (integers are read as numbers, a local database gets one
 * connection) or unsupported (embedded replicas, WebSocket URLs, encryption).
 */
export type LibsqlConnectionConfig = {
  /**
   * A local `file:` URL or `:memory:` (also `file::memory:`), or a remote
   * `libsql:`, `https:` or `http:` URL of a libSQL server (one Turso
   * database per tenant). Surrounding whitespace is ignored.
   */
  url: string;
  /** The remote database's auth token. */
  authToken?: string;
};

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
 * or in-memory database, or a remote libSQL server over HTTP.
 *
 * A local file is configured like `@takibi/node-sqlite`: WAL,
 * `synchronous=FULL`, `foreign_keys=ON`, no busy timeout. A remote database
 * gets no session settings: over HTTP every request runs on its own server
 * stream, so a `PRAGMA` does not outlive the request that set it. Its
 * journal and durability settings are the server's (`sqld` 0.24.32 runs WAL
 * with foreign keys on); Takibi's tables declare no foreign keys.
 *
 * Transactions use the client's `write` mode (`BEGIN IMMEDIATE`). Against a
 * remote database every statement is a network round trip and an open
 * transaction holds the server's write lock across them. A remote commit
 * (or autocommit write) that fails without proof that it did not take effect
 * rejects with `SQL_COMMIT_OUTCOME_UNKNOWN`; see {@link libsqlConnection}.
 *
 * Remote support is verified against a local `sqld` 0.24.32 only (see the
 * package README); Turso Cloud itself is not exercised by the tests.
 */
export async function openLibsqlConnection(
  config: LibsqlConnectionConfig,
): Promise<LibsqlConnection> {
  assertSupported(config);
  const url = config.url.trim();
  const location = locationOf(url);
  const client = createClient({
    url,
    ...(config.authToken === undefined ? {} : { authToken: config.authToken }),
    intMode: "number",
    // One connection, so per-connection pragmas cover every statement. The
    // executor serialises all use anyway.
    concurrency: 1,
  });
  const connection = libsqlConnection(client, location);
  try {
    if (location === "local") await configureLocal(connection, url);
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

const SUPPORTED_OPTIONS = new Set(["url", "authToken"]);

function assertSupported(config: LibsqlConnectionConfig): void {
  const unsupported = Object.keys(config).filter((key) => !SUPPORTED_OPTIONS.has(key));
  if (unsupported.length > 0) {
    throw new TakibiError(
      "STORAGE_BACKEND",
      `Unsupported libSQL option(s): ${unsupported.join(", ")}. Only a local database or a ` +
        "remote libSQL server over HTTP is supported; embedded replicas (syncUrl) are not.",
      500,
    );
  }
}

function locationOf(url: string): LibsqlLocation {
  if (url === ":memory:" || url.startsWith("file:")) return "local";
  if (/^(?:libsql|https?):/i.test(url)) return "remote";
  throw new TakibiError(
    "STORAGE_BACKEND",
    `Unsupported libSQL URL scheme in ${JSON.stringify(url)}: use file:, :memory:, libsql:, ` +
      "https: or http:",
    500,
  );
}

/**
 * In-memory databases, as the client recognises them: `:memory:` and
 * `file::memory:`, optionally with a `?cache=` query. The client rejects any
 * other query on a `file:` URL (so `file:name?mode=memory` never opens).
 */
function isMemory(url: string): boolean {
  return url === ":memory:" || url === "file::memory:" || url.startsWith("file::memory:?");
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
