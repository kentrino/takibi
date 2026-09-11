import { expect, test } from "vite-plus/test";
import { createSqliteDurableObjectStorage } from "../src/sqlite-storage.server";

test("Node SQLite emulation converts SELECT and write statements", () => {
  const storage = createSqliteDurableObjectStorage();
  storage.sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT)");
  const written = storage.sql.exec("INSERT INTO items (id, title) VALUES (?, ?)", "p1", "hello");
  expect(written.rowsWritten).toBe(1);
  expect(written.columnNames).toEqual([]);
  expect(written.toArray()).toEqual([]);

  const selected = storage.sql.exec<{ id: string; title: string }>("SELECT id, title FROM items");
  expect(selected.columnNames).toEqual(["id", "title"]);
  expect(selected.rowsRead).toBe(1);
  expect(selected.one()).toEqual({ id: "p1", title: "hello" });
  expect([...selected.raw()]).toEqual([["p1", "hello"]]);
  storage.close();
});

test("one() rejects an unexpected row count", () => {
  const storage = createSqliteDurableObjectStorage();
  storage.sql.exec("CREATE TABLE items (id TEXT)");
  expect(() => storage.sql.exec("SELECT id FROM items").one()).toThrow(
    /Expected exactly one row, got 0/,
  );
  storage.sql.exec("INSERT INTO items (id) VALUES (?)", "a");
  storage.sql.exec("INSERT INTO items (id) VALUES (?)", "b");
  expect(() => storage.sql.exec("SELECT id FROM items").one()).toThrow(
    /Expected exactly one row, got 2/,
  );
  storage.close();
});

test("transactionSync rolls back on throw and commits on success", () => {
  const storage = createSqliteDurableObjectStorage();
  storage.sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  expect(() =>
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO items (id) VALUES (?)", "rolled");
      throw new Error("sync fail");
    }),
  ).toThrow("sync fail");
  expect(storage.sql.exec("SELECT id FROM items").toArray()).toEqual([]);

  storage.transactionSync(() => {
    storage.sql.exec("INSERT INTO items (id) VALUES (?)", "kept");
  });
  expect(storage.sql.exec("SELECT id FROM items").one()).toEqual({ id: "kept" });
  storage.close();
});

test("async transaction rolls back on throw and commits on success", async () => {
  const storage = createSqliteDurableObjectStorage();
  storage.sql.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  await expect(
    storage.transaction(async () => {
      storage.sql.exec("INSERT INTO items (id) VALUES (?)", "rolled");
      throw new Error("async fail");
    }),
  ).rejects.toThrow("async fail");
  expect(storage.sql.exec("SELECT id FROM items").toArray()).toEqual([]);

  await storage.transaction(async () => {
    storage.sql.exec("INSERT INTO items (id) VALUES (?)", "kept");
  });
  expect(storage.sql.exec("SELECT id FROM items").one()).toEqual({ id: "kept" });
  storage.close();
});

test("deleteAll drops user tables and close is idempotent", async () => {
  const storage = createSqliteDurableObjectStorage();
  storage.sql.exec("CREATE TABLE items (id TEXT)");
  storage.sql.exec("INSERT INTO items (id) VALUES (?)", "gone");
  expect(storage.sql.databaseSize).toBeGreaterThan(0);
  await storage.deleteAll();
  const leftover = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .toArray();
  expect(leftover).toEqual([]);
  storage.close();
  storage.close();
});
