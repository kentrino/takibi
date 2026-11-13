import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LibsqlError, type Client, type Transaction } from "@libsql/client";
import { afterEach, expect, test } from "vite-plus/test";
import { SqlExecutor, isSqlCommitOutcomeUnknown } from "@takibi/storage";
import { openLibsqlConnection, openLibsqlExecutor } from "@takibi/libsql";
import { libsqlConnection, provesNotCommitted, type LibsqlLocation } from "../src/connection";

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

  const second = await openLibsqlConnection({ url });
  try {
    const [row] = (await second.exec("SELECT id, n FROM items")).rows;
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

// Remote failures cannot be produced without a server, so the classification
// of commit failures is tested against a scripted client.

class ResponseError extends Error {
  override name = "ResponseError";
}

const lostResponse = () =>
  new LibsqlError("fetch failed", "UNKNOWN", undefined, undefined, new TypeError("fetch failed"));
const serverAnswered = () =>
  new LibsqlError(
    "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed",
    "SQLITE_CONSTRAINT",
    undefined,
    undefined,
    new ResponseError("constraint"),
  );
const closedBeforeSending = () =>
  new LibsqlError(
    "Cannot commit the transaction because it is already closed",
    "TRANSACTION_CLOSED",
  );

function scriptedClient(commitError: unknown) {
  const calls = { begin: 0, statements: 0, commit: 0, rollback: 0, close: 0, autocommit: 0 };
  const transaction = {
    async execute() {
      calls.statements += 1;
      return { rows: [] };
    },
    async commit() {
      calls.commit += 1;
      if (commitError !== undefined) throw commitError;
    },
    async rollback() {
      calls.rollback += 1;
    },
    close() {
      calls.close += 1;
    },
  } as unknown as Transaction;
  const client = {
    async execute() {
      calls.autocommit += 1;
      if (commitError !== undefined) throw commitError;
      return { rows: [] };
    },
    async transaction(mode: string) {
      expect(mode).toBe("write");
      calls.begin += 1;
      return transaction;
    },
    close() {},
  } as unknown as Client;
  return { client, calls };
}

async function commitThrough(location: LibsqlLocation, commitError: unknown) {
  const { client, calls } = scriptedClient(commitError);
  const sql = new SqlExecutor(libsqlConnection(client, location));
  let bodies = 0;
  const outcome = await sql
    .transaction(async (tx) => {
      bodies += 1;
      await tx.exec("INSERT INTO items (id) VALUES ('x')");
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  return { outcome, calls, bodies };
}

test("a remote commit whose response was lost surfaces as an unknown outcome, once", async () => {
  const lost = lostResponse();
  const { outcome, calls, bodies } = await commitThrough("remote", lost);
  expect(isSqlCommitOutcomeUnknown(outcome)).toBe(true);
  expect((outcome as Error).cause).toBe(lost);
  // Neither the body nor the commit is attempted again.
  expect({ bodies, begin: calls.begin, commit: calls.commit, close: calls.close }).toEqual({
    bodies: 1,
    begin: 1,
    commit: 1,
    close: 1,
  });
});

test("a commit the server answered, or never received, is an ordinary failure", async () => {
  for (const location of ["remote", "replica"] as const) {
    for (const error of [serverAnswered(), closedBeforeSending()]) {
      const { outcome } = await commitThrough(location, error);
      expect(outcome).toBe(error);
    }
  }
  // A local commit failure is always known.
  const local = lostResponse();
  expect((await commitThrough("local", local)).outcome).toBe(local);
  // A replica failure without an SQLite result code may have reached the primary.
  expect(isSqlCommitOutcomeUnknown((await commitThrough("replica", lostResponse())).outcome)).toBe(
    true,
  );
});

test("an autocommit write whose response was lost is an unknown outcome too", async () => {
  const { client, calls } = scriptedClient(lostResponse());
  const connection = libsqlConnection(client, "remote");
  const error = await connection.exec("INSERT INTO items (id) VALUES ('x')").catch((e) => e);
  expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
  expect(calls.autocommit).toBe(1);
});

test("a rejected body rolls back and rejects with its own error, without committing", async () => {
  const { client, calls } = scriptedClient(undefined);
  const failure = new Error("body failed");
  await expect(
    libsqlConnection(client, "remote").transaction(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(calls).toMatchObject({ commit: 0, rollback: 1, close: 1 });
});

test("only the response-carrying and pre-send errors prove a remote write did not commit", () => {
  expect(provesNotCommitted("remote", serverAnswered())).toBe(true);
  expect(provesNotCommitted("remote", closedBeforeSending())).toBe(true);
  expect(provesNotCommitted("remote", lostResponse())).toBe(false);
  expect(provesNotCommitted("remote", new TypeError("socket hang up"))).toBe(false);
  expect(provesNotCommitted("remote", new LibsqlError("server error", "SERVER_ERROR"))).toBe(false);
  expect(provesNotCommitted("local", new TypeError("anything"))).toBe(true);
});
