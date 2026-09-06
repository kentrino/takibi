import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Testing from "../src";
import * as SqliteStorage from "../src/sqlite-storage.server";

test("testing package exports the SQLite handler adapter", () => {
  expectTypeOf(Testing.withSqliteTestBackend).toBeFunction();
  expectTypeOf<Testing.SqliteTestBackendOptions<object, object, object>>().not.toBeNever();
  expectTypeOf(Testing).not.toHaveProperty("createMemoryStorage");
  expectTypeOf(Testing).not.toHaveProperty("createMemoryExecutor");
  expectTypeOf(Testing).not.toHaveProperty("createInProcessRuntime");
  expectTypeOf(Testing).not.toHaveProperty("registerTestingFork");
  expectTypeOf(Testing).not.toHaveProperty("getTestingFork");
  expectTypeOf(Testing).not.toHaveProperty("createTakibi");
  expectTypeOf(Testing).not.toHaveProperty("createClient");
  expectTypeOf(Testing).not.toHaveProperty("createSqliteDurableObjectStorage");
});

test("sqlite-storage is a dedicated subpath, not a root export", () => {
  expectTypeOf(SqliteStorage.createSqliteDurableObjectStorage).toBeFunction();
  expectTypeOf<SqliteStorage.SqliteDurableObjectStorage>().toHaveProperty("close");
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports["."]).toBe("./src/index.ts");
  expect(pkg.exports["./sqlite-storage"]).toBe("./src/sqlite-storage.server.ts");
});

test("published declarations keep memory helpers and the runtime bridge off the root", () => {
  const dtsPath = join(import.meta.dirname, "../dist/index.d.mts");
  const jsPath = join(import.meta.dirname, "../dist/index.mjs");
  const sqliteJsPath = join(import.meta.dirname, "../dist/sqlite-storage.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath) || !existsSync(sqliteJsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  const sqliteJs = readFileSync(sqliteJsPath, "utf8");
  expect(dts).not.toMatch(/createMemoryStorage|createMemoryExecutor|createInProcessRuntime/);
  expect(dts).not.toMatch(/export \{[^}]*createInProcessRuntime/);
  expect(js).not.toMatch(/createMemoryStorage|createMemoryExecutor/);
  expect(js).not.toMatch(/export \{[^}]*createInProcessRuntime/);
  expect(sqliteJs).toContain("node:sqlite");
});
