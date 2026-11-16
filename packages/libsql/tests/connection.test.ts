import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, LibsqlError, type Client, type Transaction } from "@libsql/client";
import { afterEach, expect, test } from "vite-plus/test";
import {
  isSqlCommitOutcomeUnknown,
  openSqliteStorage,
  SqlExecutor,
  type StoredDocument,
} from "@takibi/storage";
import { libsqlConnection, openLibsqlConnection, openLibsqlExecutor } from "@takibi/libsql";
import { remoteFailureProvesNotCommitted } from "../src/connection";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fileUrl(): string {
  const directory = mkdtempSync(join(tmpdir(), "takibi-libsql-"));
  directories.push(directory);
  return pathToFileURL(join(directory, "tenant.db")).href;
}

test("a local file is opened in WAL mode with full synchronous commits", async () => {
  const connection = await openLibsqlConnection({ url: fileUrl() });
  try {
    expect(connection.location).toBe("local");
    const pragma = async (name: string) => (await connection.exec(`PRAGMA ${name}`)).rows[0];
    expect(await pragma("journal_mode")).toEqual({ journal_mode: "wal" });
    expect(await pragma("synchronous")).toEqual({ synchronous: 2 });
    expect(await pragma("foreign_keys")).toEqual({ foreign_keys: 1 });
  } finally {
    connection.close();
  }
});

test("in-memory URLs are recognised the way the client recognises them", async () => {
  for (const url of [":memory:", "  :memory:\n", "file::memory:", "file::memory:?cache=private"]) {
    const connection = await openLibsqlConnection({ url });
    try {
      expect(connection.location, url).toBe("local");
      expect((await connection.exec("PRAGMA foreign_keys")).rows[0], url).toEqual({
        foreign_keys: 1,
      });
      expect((await connection.exec("PRAGMA journal_mode")).rows[0], url).toEqual({
        journal_mode: "memory",
      });
    } finally {
      connection.close();
    }
  }
  // A padded file URL opens the same file as the trimmed one, in WAL mode.
  const url = fileUrl();
  const padded = await openLibsqlConnection({ url: ` ${url} ` });
  try {
    expect((await padded.exec("PRAGMA journal_mode")).rows[0]).toEqual({ journal_mode: "wal" });
  } finally {
    padded.close();
  }
  // The client accepts no other query on a file URL, so this is not an
  // in-memory database but a client configuration error.
  await expect(openLibsqlConnection({ url: "file:tenant?mode=memory" })).rejects.toMatchObject({
    code: "URL_PARAM_NOT_SUPPORTED",
  });
});

test("embedded replicas, WebSocket URLs, and other client options are refused", async () => {
  const replica = { url: fileUrl(), syncUrl: "libsql://primary.example" };
  await expect(openLibsqlConnection(replica as never)).rejects.toMatchObject({
    code: "STORAGE_BACKEND",
    message: expect.stringContaining("syncUrl"),
  });
  await expect(
    openLibsqlConnection({ url: ":memory:", offline: true } as never),
  ).rejects.toMatchObject({ code: "STORAGE_BACKEND", message: expect.stringContaining("offline") });
  await expect(openLibsqlConnection({ url: "wss://db.example" })).rejects.toMatchObject({
    code: "STORAGE_BACKEND",
  });
});

test("rows are plain objects of named columns, and committed data survives reopening", async () => {
  const url = fileUrl();
  const first = await openLibsqlConnection({ url });
  await first.exec("CREATE TABLE items (id TEXT PRIMARY KEY, n REAL)");
  await first.transaction(async (tx) => {
    await tx.exec("INSERT INTO items (id, n) VALUES (?, ?)", "kept", 1.5);
  });
  first.close();
  first.close();
  await expect(first.exec("SELECT 1")).rejects.toMatchObject({ code: "SQL_CONNECTION_CLOSED" });
  await expect(first.read!("SELECT 1")).rejects.toMatchObject({ code: "SQL_CONNECTION_CLOSED" });

  const second = await openLibsqlConnection({ url });
  try {
    const [row] = (await second.read!("SELECT id, n FROM items")).rows;
    expect(Object.keys(row!)).toEqual(["id", "n"]);
    expect(row).toEqual({ id: "kept", n: 1.5 });
  } finally {
    second.close();
  }
});

test("an unsafe integer result rejects instead of losing precision", async () => {
  const connection = await openLibsqlConnection({ url: ":memory:" });
  try {
    await expect(connection.exec("SELECT 9007199254740993 AS v")).rejects.toBeInstanceOf(
      RangeError,
    );
  } finally {
    connection.close();
  }
});

test("the executor rejects a reentrant call from anywhere inside its transaction", async () => {
  const sql = await openLibsqlExecutor({ url: ":memory:" });
  try {
    await sql.transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(sql.exec("SELECT 1")).rejects.toMatchObject({ code: "SQL_REENTRANT_CALL" });
    });
  } finally {
    sql.close();
  }
});

// A remote-shaped client: a real in-memory database behind the client
// interface, connected as `remote`, whose next request can be made to fail
// the way a network failure surfaces (`fetch failed` is a plain TypeError;
// see tests/remote.test.ts for the same paths against a real server).

const networkFailure = () => new TypeError("fetch failed");

type Fault = { at: "execute" | "statement" | "commit"; error: unknown };

function remoteShapedClient() {
  const inner = createClient({ url: ":memory:", intMode: "number", concurrency: 1 });
  const calls = { execute: 0, statements: 0, commit: 0, rollback: 0 };
  let fault: Fault | undefined;
  const take = (at: Fault["at"]) => {
    if (fault?.at !== at) return;
    const { error } = fault;
    fault = undefined;
    throw error;
  };
  const client = {
    async execute(statement: Parameters<Client["execute"]>[0]) {
      calls.execute += 1;
      take("execute");
      return inner.execute(statement);
    },
    async transaction(mode: "write") {
      expect(mode).toBe("write");
      const transaction = await inner.transaction(mode);
      return {
        async execute(statement: Parameters<Transaction["execute"]>[0]) {
          calls.statements += 1;
          take("statement");
          return transaction.execute(statement);
        },
        async commit() {
          calls.commit += 1;
          await transaction.commit();
          // The commit happened; its response is lost.
          take("commit");
        },
        async rollback() {
          calls.rollback += 1;
          return transaction.rollback();
        },
        close: () => transaction.close(),
      } as unknown as Transaction;
    },
    close: () => inner.close(),
  } as unknown as Client;
  return {
    client,
    calls,
    failNext: (at: Fault["at"], error: unknown = networkFailure()) => {
      fault = { at, error };
      return error;
    },
  };
}

const doc = (id: string): StoredDocument => ({
  id,
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T00:00:00.000Z",
  title: id,
});

async function remoteStorage() {
  const remote = remoteShapedClient();
  const sql = new SqlExecutor(libsqlConnection(remote.client, "remote"));
  const { storage } = await openSqliteStorage(sql);
  await storage.put("posts", doc("existing"));
  return { ...remote, sql, storage };
}

test("a failed read on a remote database is an ordinary error, never an unknown outcome", async () => {
  const { storage, sql, failNext } = await remoteStorage();
  let failure = failNext("execute");
  await expect(storage.get("posts", "existing")).rejects.toBe(failure);
  failure = failNext("execute");
  await expect(storage.list("posts")).rejects.toBe(failure);
  failure = failNext("execute", new LibsqlError("Server returned HTTP status 502", "SERVER_ERROR"));
  await expect(sql.read("SELECT 1")).rejects.toBe(failure);
  await expect(storage.get("posts", "existing")).resolves.toMatchObject({ id: "existing" });
});

test("a failed autocommit write on a remote database is an unknown outcome, sent once", async () => {
  const { storage, calls, failNext } = await remoteStorage();
  const before = calls.execute;
  const lost = failNext("execute");
  const error = await storage.put("posts", doc("lost")).catch((caught: unknown) => caught);
  expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
  expect((error as Error).cause).toBe(lost);
  expect(calls.execute).toBe(before + 1);

  // The server's SQLite rejecting the write proves it did not commit.
  const connection = libsqlConnection(remoteShapedClient().client, "remote");
  await connection.exec("CREATE TABLE t (k TEXT PRIMARY KEY)");
  await connection.exec("INSERT INTO t VALUES ('a')");
  const rejected = await connection
    .exec("INSERT INTO t VALUES ('a')")
    .catch((caught: unknown) => caught);
  expect(rejected).toBeInstanceOf(LibsqlError);
  expect((rejected as LibsqlError).code).toMatch(/^SQLITE_CONSTRAINT/);
});

test("a failed statement inside a remote transaction is an ordinary error and rolls back", async () => {
  const { storage, calls, failNext } = await remoteStorage();
  const commits = calls.commit;
  let bodies = 0;
  const failure = failNext("statement");
  await expect(
    storage.transaction(async (tx) => {
      bodies += 1;
      await tx.put("posts", doc("rolled-back"));
    }),
  ).rejects.toBe(failure);
  expect({ bodies, commits: calls.commit - commits, rollback: calls.rollback }).toEqual({
    bodies: 1,
    commits: 0,
    rollback: 1,
  });
  await expect(storage.get("posts", "rolled-back")).resolves.toBeNull();
});

test("a remote COMMIT whose response was lost is an unknown outcome, attempted once", async () => {
  const { storage, calls, failNext } = await remoteStorage();
  const commits = calls.commit;
  let bodies = 0;
  const lost = failNext("commit");
  const error = await storage
    .transaction(async (tx) => {
      bodies += 1;
      await tx.put("posts", doc("committed"));
    })
    .catch((caught: unknown) => caught);
  expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
  expect((error as Error).cause).toBe(lost);
  expect({ bodies, commits: calls.commit - commits }).toEqual({ bodies: 1, commits: 1 });
  // It did commit here; the caller learns that only by reading again.
  await expect(storage.get("posts", "committed")).resolves.toMatchObject({ id: "committed" });

  // A commit the server's SQLite refused, or one the client never sent, is known.
  for (const known of [
    new LibsqlError("database is locked", "SQLITE_BUSY"),
    new LibsqlError(
      "Cannot commit the transaction because it is already closed",
      "TRANSACTION_CLOSED",
    ),
  ]) {
    failNext("commit", known);
    await expect(storage.transaction((tx) => tx.put("posts", doc("known")))).rejects.toBe(known);
  }
});

test("a local database reports every failure as itself", async () => {
  const local = remoteShapedClient();
  const connection = libsqlConnection(local.client, "local");
  const failure = local.failNext("execute");
  await expect(connection.exec("INSERT INTO nowhere VALUES (1)")).rejects.toBe(failure);
});

test("a rejected body rolls back and rejects with its own error, without committing", async () => {
  const { client, calls } = remoteShapedClient();
  const failure = new Error("body failed");
  await expect(
    libsqlConnection(client, "remote").transaction(async (tx) => {
      await tx.exec("SELECT 1");
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(calls).toMatchObject({ commit: 0, rollback: 1 });
});

test("only SQLite result codes and an unsent commit prove a remote write did not commit", () => {
  const proves = (error: unknown) => remoteFailureProvesNotCommitted(error);
  expect(proves(new LibsqlError("UNIQUE constraint failed", "SQLITE_CONSTRAINT"))).toBe(true);
  expect(proves(new LibsqlError("database is locked", "SQLITE_BUSY"))).toBe(true);
  expect(proves(new LibsqlError("already closed", "TRANSACTION_CLOSED"))).toBe(true);
  // Transport failures, and server errors that are not SQLite's verdict.
  expect(proves(new TypeError("fetch failed"))).toBe(false);
  expect(proves(new LibsqlError("HTTP status 502", "SERVER_ERROR"))).toBe(false);
  expect(proves(new LibsqlError("stream closed", "HRANA_CLOSED_ERROR"))).toBe(false);
  expect(proves(new LibsqlError("protocol", "HRANA_PROTO_ERROR"))).toBe(false);
  expect(proves(new LibsqlError("response without a code", "UNKNOWN"))).toBe(false);
  expect(proves(new LibsqlError("could not parse", "SQL_PARSE_ERROR"))).toBe(false);
  // A look-alike that is not the client's error class proves nothing.
  expect(proves(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBe(false);
});

test("the classification was checked against these client versions; re-check on upgrade", () => {
  // remoteFailureProvesNotCommitted depends on how @libsql/client maps
  // transport and server failures to LibsqlError codes (mapHranaError in
  // @libsql/client, errors in @libsql/hrana-client). Re-read both, run
  // tests/remote.test.ts against sqld, then update these versions.
  const require = createRequire(import.meta.url);
  // require resolves to <package>/lib-cjs/<entry>.js
  const clientDir = dirname(dirname(require.resolve("@libsql/client")));
  const version = (dir: string) =>
    (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  expect(version(clientDir)).toBe("0.18.0");
  const hrana = createRequire(join(clientDir, "package.json")).resolve("@libsql/hrana-client");
  expect(version(dirname(dirname(hrana)))).toBe("0.10.0");
});
