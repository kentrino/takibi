import { expect, test } from "vite-plus/test";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";

test("Node SQLite executor returns rows for SELECT and rowsWritten for writes", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT)");
  const written = await sql.exec("INSERT INTO items (id, title) VALUES (?, ?)", "p1", "hello");
  expect(written).toEqual({ rows: [], rowsWritten: 1 });

  const ignored = await sql.exec(
    "INSERT OR IGNORE INTO items (id, title) VALUES (?, ?)",
    "p1",
    "again",
  );
  expect(ignored.rowsWritten).toBe(0);

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
