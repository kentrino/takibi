import { expect, test } from "vite-plus/test";
import { openSqliteStorage } from "@takibi/storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";

test("Node SQLite executor returns rows for SELECT and RETURNING, none for plain writes", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT)");
  const written = await sql.exec("INSERT INTO items (id, title) VALUES (?, ?)", "p1", "hello");
  expect(written).toEqual({ rows: [] });

  const ignored = await sql.exec<{ id: string }>(
    "INSERT OR IGNORE INTO items (id, title) VALUES (?, ?) RETURNING id",
    "p1",
    "again",
  );
  expect(ignored.rows).toEqual([]);

  const selected = await sql.exec<{ id: string; title: string }>("SELECT id, title FROM items");
  expect(selected.rows).toEqual([{ id: "p1", title: "hello" }]);

  const returned = await sql.exec<{ id: string }>(
    "DELETE FROM items WHERE id = ? RETURNING id",
    "p1",
  );
  expect(returned.rows).toEqual([{ id: "p1" }]);
  sql.close();
});

test("Node SQLite executor rejects invalid statements", async () => {
  const sql = createNodeSqliteExecutor();
  await expect(sql.exec("SELECT * FROM missing_table")).rejects.toThrow(/no such table/);
  sql.close();
});

test("transaction rolls back on rejection and commits on success", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  let calls = 0;
  await expect(
    sql.transaction(async (tx) => {
      calls += 1;
      await tx.exec("INSERT INTO items (id) VALUES (?)", "rolled");
      throw new Error("async fail");
    }),
  ).rejects.toThrow("async fail");
  expect(calls).toBe(1);
  expect((await sql.exec("SELECT id FROM items")).rows).toEqual([]);

  await expect(
    sql.transaction(async (tx) => {
      await tx.exec("INSERT INTO items (id) VALUES (?)", "kept");
      return "done";
    }),
  ).resolves.toBe("done");
  expect((await sql.exec("SELECT id FROM items")).rows).toEqual([{ id: "kept" }]);
  sql.close();
});

test("close is idempotent", () => {
  const sql = createNodeSqliteExecutor();
  sql.close();
  sql.close();
});

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a statement issued during an open transaction is not rolled back with it", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  const transaction = sql.transaction(async (tx) => {
    await tx.exec("INSERT INTO items (id) VALUES (?)", "rolled");
    await macrotask();
    throw new Error("roll back");
  });
  await macrotask();
  const outside = sql.exec("INSERT INTO items (id) VALUES (?)", "outside");
  await expect(transaction).rejects.toThrow("roll back");
  await outside;
  expect((await sql.exec("SELECT id FROM items")).rows).toEqual([{ id: "outside" }]);
  sql.close();
});

test("overlapping transactions run one after the other instead of nesting BEGIN", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  const first = sql.transaction(async (tx) => {
    await macrotask();
    await tx.exec("INSERT INTO items (id) VALUES (?)", "first");
  });
  const second = sql.transaction(async (tx) => {
    await tx.exec("INSERT INTO items (id) VALUES (?)", "second");
  });
  await Promise.all([first, second]);
  expect((await sql.exec("SELECT id FROM items ORDER BY id")).rows).toEqual([
    { id: "first" },
    { id: "second" },
  ]);
  sql.close();
});

test("the storage driver rejects a reentrant call from inside its transaction instead of hanging", async () => {
  const sql = createNodeSqliteExecutor();
  const storage = await openSqliteStorage(sql);
  const doc = (id: string) => ({
    id,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
  });
  await storage.transaction(async (tx) => {
    await tx.put("posts", doc("inside"));
    // The outer driver would wait for this transaction forever.
    await expect(storage.get("posts", "inside")).rejects.toMatchObject({
      code: "SQL_REENTRANT_CALL",
    });
    await expect(storage.transaction(async () => "unreached")).rejects.toMatchObject({
      code: "SQL_REENTRANT_CALL",
    });
    // A nested transaction on the transaction's driver joins it.
    await tx.transaction(async (nested) => nested.put("posts", doc("nested")));
  });
  const outside = storage.transaction(async (tx) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return tx.get("posts", "inside");
  });
  // An independent call waits for the open transaction rather than failing.
  const independent = storage.list("posts");
  await expect(outside).resolves.toMatchObject({ id: "inside" });
  expect((await independent).items.map(({ id }) => id)).toEqual(["inside", "nested"]);
  sql.close();
});
