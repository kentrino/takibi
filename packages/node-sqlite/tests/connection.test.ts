import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  openNodeSqliteConnection,
  openNodeSqliteExecutor,
  type NodeSqliteConnection,
} from "@takibi/node-sqlite";

const directories: string[] = [];
const open: NodeSqliteConnection[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "takibi-node-sqlite-"));
  directories.push(directory);
  return join(directory, "tenant.sqlite");
}

function connect(location: string, options?: Parameters<typeof openNodeSqliteConnection>[1]) {
  const connection = openNodeSqliteConnection(location, options);
  open.push(connection);
  return connection;
}

afterEach(() => {
  for (const connection of open.splice(0)) connection.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("a file database is opened in WAL mode with full synchronous commits and no busy wait", async () => {
  const connection = connect(databasePath());
  const pragma = async (name: string) => (await connection.exec(`PRAGMA ${name}`)).rows[0];
  expect(await pragma("journal_mode")).toEqual({ journal_mode: "wal" });
  expect(await pragma("synchronous")).toEqual({ synchronous: 2 });
  expect(await pragma("foreign_keys")).toEqual({ foreign_keys: 1 });
  expect(await pragma("busy_timeout")).toEqual({ timeout: 0 });
});

test("busy timeout is configurable and validated", async () => {
  const connection = connect(databasePath(), { busyTimeoutMs: 250 });
  expect((await connection.exec("PRAGMA busy_timeout")).rows[0]).toEqual({ timeout: 250 });
  expect(() => openNodeSqliteConnection(databasePath(), { busyTimeoutMs: -1 })).toThrow(TypeError);
});

test("an in-memory database needs no file and keeps the memory journal", async () => {
  const connection = connect(":memory:");
  expect((await connection.exec("PRAGMA journal_mode")).rows[0]).toEqual({
    journal_mode: "memory",
  });
});

test("committed data survives reopening the file", async () => {
  const location = databasePath();
  const first = openNodeSqliteConnection(location);
  await first.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  await first.transaction(async (tx) => {
    await tx.exec("INSERT INTO items (id) VALUES (?)", "kept");
  });
  first.close();
  const second = connect(location);
  expect((await second.exec("SELECT id FROM items")).rows).toEqual([{ id: "kept" }]);
});

test("a transaction holds the write lock from its start, so another writer fails at once", async () => {
  const location = databasePath();
  const owner = connect(location);
  await owner.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  const intruder = connect(location);
  await owner.transaction(async () => {
    // BEGIN IMMEDIATE took the lock before any statement ran.
    await expect(intruder.exec("INSERT INTO items (id) VALUES ('x')")).rejects.toMatchObject({
      errcode: 5, // SQLITE_BUSY
    });
    // Readers are not blocked in WAL mode.
    await expect(intruder.exec("SELECT count(*) AS n FROM items")).resolves.toEqual({
      rows: [{ n: 0 }],
    });
  });
});

test("a cached statement keeps working after a schema change", async () => {
  const connection = connect(":memory:");
  await connection.exec("CREATE TABLE items (id TEXT PRIMARY KEY, v INTEGER)");
  const select = "SELECT id FROM items WHERE v = ?";
  await connection.exec("INSERT INTO items (id, v) VALUES ('a', 1)");
  expect((await connection.exec(select, 1)).rows).toEqual([{ id: "a" }]);
  await connection.exec("CREATE INDEX items_v ON items (v)");
  await connection.exec("ALTER TABLE items ADD COLUMN w TEXT");
  expect((await connection.exec(select, 1)).rows).toEqual([{ id: "a" }]);
});

test("close is idempotent, rolls back an open transaction, and later calls reject", async () => {
  const location = databasePath();
  const connection = openNodeSqliteConnection(location);
  await connection.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const transaction = connection.transaction(async (tx) => {
    await tx.exec("INSERT INTO items (id) VALUES ('lost')");
    await held;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  connection.close();
  connection.close();
  release();
  await expect(transaction).rejects.toThrow();
  await expect(connection.exec("SELECT 1")).rejects.toMatchObject({
    code: "SQL_CONNECTION_CLOSED",
  });
  const reopened = connect(location);
  expect((await reopened.exec("SELECT id FROM items")).rows).toEqual([]);
});

test("a process killed mid-transaction leaves only committed data and an intact file", async () => {
  const location = databasePath();
  const setup = openNodeSqliteConnection(location);
  await setup.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  await setup.exec("INSERT INTO items (id) VALUES ('committed')");
  setup.close();

  // A separate process opens the database the same way, writes inside an
  // open transaction, and is killed before COMMIT.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--no-warnings",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = FULL");
        db.exec("BEGIN IMMEDIATE");
        for (let i = 0; i < 1000; i++) db.prepare("INSERT INTO items (id) VALUES (?)").run("lost-" + i);
        process.kill(process.pid, "SIGKILL");
      `,
      location,
    ],
    { encoding: "utf8" },
  );
  expect(child.signal).toBe("SIGKILL");

  const reopened = connect(location);
  expect((await reopened.exec("PRAGMA integrity_check")).rows).toEqual([{ integrity_check: "ok" }]);
  expect((await reopened.exec("SELECT id FROM items")).rows).toEqual([{ id: "committed" }]);
});

test("the executor rejects a reentrant call from anywhere inside its transaction", async () => {
  const sql = openNodeSqliteExecutor(":memory:");
  try {
    await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
    await sql.transaction(async (tx) => {
      await tx.exec("INSERT INTO items (id) VALUES ('a')");
      await new Promise((resolve) => setTimeout(resolve, 0));
      // After an await, only the async context can tell this call is reentrant.
      await expect(sql.exec("SELECT 1")).rejects.toMatchObject({ code: "SQL_REENTRANT_CALL" });
    });
    expect(sql.location).toBe(":memory:");
  } finally {
    sql.close();
  }
});
