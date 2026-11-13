import { describe, expect, test } from "vite-plus/test";
import type { SqlExecutor, SqlRow } from "@takibi/storage";
import { plain, type ConformanceTarget } from "./target";

async function first<Row extends SqlRow = SqlRow>(
  sql: SqlExecutor,
  query: string,
  ...bindings: (string | number | null)[]
): Promise<Row | undefined> {
  return plain((await sql.exec<Row>(query, ...bindings)).rows[0]);
}

/**
 * The SQL port contract (`SqlConnection` behind `SqlExecutor`) and every
 * SQLite feature the engine relies on, probed directly so that a SQLite
 * build missing one fails here by name rather than somewhere in the engine.
 */
export function defineSqlPortTests(target: ConformanceTarget): void {
  describe("SQL port", () => {
    test("statements return materialised rows; plain writes return none", () =>
      target.withDatabase("port-rows", async (sql) => {
        await sql.exec(
          "CREATE TABLE t (k TEXT PRIMARY KEY, i INTEGER, r REAL, s TEXT, n TEXT) WITHOUT ROWID",
        );
        await expect(
          sql.exec("INSERT INTO t VALUES (?, ?, ?, ?, ?)", "a", 7, 1.5, "text", null),
        ).resolves.toEqual({ rows: [] });
        expect(
          await first(sql, "SELECT k, i, r, s, n, typeof(i) AS ti, typeof(r) AS tr FROM t"),
        ).toEqual({ k: "a", i: 7, r: 1.5, s: "text", n: null, ti: "integer", tr: "real" });
        expect(
          (await sql.exec("INSERT INTO t (k) VALUES (?) RETURNING k", "b")).rows.map(plain),
        ).toEqual([{ k: "b" }]);
        expect(
          (await sql.exec("INSERT OR IGNORE INTO t (k) VALUES (?) RETURNING k", "b")).rows,
        ).toEqual([]);
        expect(
          (await sql.exec("DELETE FROM t WHERE k = ? RETURNING k", "b")).rows.map(plain),
        ).toEqual([{ k: "b" }]);
        expect((await sql.exec("SELECT k FROM t WHERE k = ?", "missing")).rows).toEqual([]);
      }));

    test("numbers bind and read back as JavaScript numbers", () =>
      target.withDatabase("port-numbers", async (sql) => {
        // JavaScript numbers are usable wherever the engine binds them:
        // comparisons with INTEGER values, LIMIT, and INTEGER columns.
        // Every supported driver binds a JavaScript number as REAL, integral or not.
        expect(
          await first(
            sql,
            "SELECT ? = 1 AS eq, ? + 1 AS sum, typeof(?) AS integral, typeof(?) AS fraction",
            1,
            2,
            1,
            1.5,
          ),
        ).toEqual({ eq: 1, sum: 3, integral: "real", fraction: "real" });
        await sql.exec("CREATE TABLE n (v INTEGER NOT NULL)");
        await sql.exec("INSERT INTO n (v) VALUES (?), (?), (?)", 1, 2, 3);
        expect((await sql.exec("SELECT v FROM n ORDER BY v LIMIT ?", 2)).rows.map(plain)).toEqual([
          { v: 1 },
          { v: 2 },
        ]);
        expect(await first(sql, "SELECT typeof(v) AS t FROM n LIMIT 1")).toEqual({ t: "integer" });
        // REAL values beyond the safe integer range keep their exact double.
        const big = 2 ** 64;
        expect(await first(sql, "SELECT ? AS v, CAST(2 AS REAL) AS two", big)).toEqual({
          v: big,
          two: 2,
        });
        expect(await first(sql, "SELECT ? AS v", Number.MAX_VALUE)).toEqual({
          v: Number.MAX_VALUE,
        });
      }));

    test("an INTEGER result outside the safe integer range is rejected or rounded, never garbled", () =>
      target.withDatabase("port-unsafe-integer", async (sql) => {
        // Backend-defined, and the engine never reads such a value (revisions
        // are REAL; versions and counts are small). node:sqlite and libSQL
        // reject; a Durable Object rounds to the nearest double.
        let value: unknown;
        try {
          value = (await first(sql, "SELECT 9007199254740993 AS v"))?.v;
        } catch {
          return;
        }
        expect(value).toBe(9007199254740992);
      }));

    test("failed statements reject and leave the database usable", () =>
      target.withDatabase("port-errors", async (sql) => {
        await expect(sql.exec("SELECT * FROM missing_table")).rejects.toThrow();
        await expect(sql.exec("NOT SQL")).rejects.toThrow();
        await sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY)");
        await sql.exec("INSERT INTO t (k) VALUES ('a')");
        await expect(sql.exec("INSERT INTO t (k) VALUES ('a')")).rejects.toThrow();
        await expect(sql.exec("SELECT count(*) AS c FROM t")).resolves.toMatchObject({
          rows: [{ c: 1 }],
        });
      }));

    test("a transaction runs its body once, commits on fulfilment, and rolls back on rejection", () =>
      target.withDatabase("port-transactions", async (sql) => {
        await sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY)");
        let calls = 0;
        await expect(
          sql.transaction(async (tx) => {
            calls += 1;
            await tx.exec("INSERT INTO t (k) VALUES ('kept')");
            // Reads inside the transaction see its own writes.
            expect((await tx.exec("SELECT k FROM t")).rows.map(plain)).toEqual([{ k: "kept" }]);
            return "done";
          }),
        ).resolves.toBe("done");
        const failure = new Error("roll back");
        await expect(
          sql.transaction(async (tx) => {
            calls += 1;
            await tx.exec("INSERT INTO t (k) VALUES ('rolled')");
            throw failure;
          }),
        ).rejects.toBe(failure);
        expect(calls).toBe(2);
        expect((await sql.exec("SELECT k FROM t ORDER BY k")).rows.map(plain)).toEqual([
          { k: "kept" },
        ]);
      }));

    test("a failed statement inside a transaction does not abort it", () =>
      target.withDatabase("port-statement-failure", async (sql) => {
        await sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY)");
        await sql.exec("INSERT INTO t (k) VALUES ('a')");
        await sql.transaction(async (tx) => {
          await tx.exec("INSERT INTO t (k) VALUES ('b')");
          await expect(tx.exec("INSERT INTO t (k) VALUES ('a')")).rejects.toThrow();
          await tx.exec("INSERT INTO t (k) VALUES ('c')");
        });
        expect((await sql.exec("SELECT k FROM t ORDER BY k")).rows.map(plain)).toEqual([
          { k: "a" },
          { k: "b" },
          { k: "c" },
        ]);
      }));

    test("schema changes are transactional", () =>
      target.withDatabase("port-transactional-ddl", async (sql) => {
        await sql.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
        await expect(
          sql.transaction(async (tx) => {
            await tx.exec("CREATE INDEX t_v ON t (v)");
            await tx.exec("ALTER TABLE t RENAME TO renamed");
            throw new Error("roll back DDL");
          }),
        ).rejects.toThrow("roll back DDL");
        expect(
          (
            await sql.exec("SELECT name FROM sqlite_master WHERE name IN ('t', 't_v', 'renamed')")
          ).rows.map(plain),
        ).toEqual([{ name: "t" }]);
      }));

    test("JSON functions behave as the query lowering expects", () =>
      target.withDatabase("port-json", async (sql) => {
        expect(
          await first(
            sql,
            `SELECT json_extract(?, '$."a"."b"') AS v, json_type(?, '$.a') AS t,
                    json_valid(?) AS ok, json_valid(?) AS bad, json_remove(?, '$.a') AS removed`,
            '{"a":{"b":2}}',
            '{"a":1}',
            '{"a":1}',
            "{a:1}",
            '{"a":1,"b":2}',
          ),
        ).toEqual({ v: 2, t: "integer", ok: 1, bad: 0, removed: '{"b":2}' });
        expect(
          (
            await sql.exec(
              "SELECT key, type, atom FROM json_each(?) ORDER BY key",
              '{"s":"x","i":3,"r":1.5,"n":null,"t":true,"f":false,"o":{}}',
            )
          ).rows.map(plain),
        ).toEqual([
          { key: "f", type: "false", atom: 0 },
          { key: "i", type: "integer", atom: 3 },
          { key: "n", type: "null", atom: null },
          { key: "o", type: "object", atom: null },
          { key: "r", type: "real", atom: 1.5 },
          { key: "s", type: "text", atom: "x" },
          { key: "t", type: "true", atom: 1 },
        ]);
        await sql.exec(
          `CREATE TABLE d (data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'))`,
        );
        await expect(sql.exec("INSERT INTO d (data) VALUES (?)", "[1]")).rejects.toThrow();
        await expect(sql.exec("INSERT INTO d (data) VALUES (?)", "{bad")).rejects.toThrow();
      }));

    test("time, upsert with WHERE, RETURNING, and row values work as the lease relies on", () =>
      target.withDatabase("port-lease-sql", async (sql) => {
        const now = await first<{ now: number; type: string }>(
          sql,
          "SELECT unixepoch('now', 'subsec') AS now, typeof(unixepoch('now', 'subsec')) AS type",
        );
        expect(now?.type).toBe("real");
        expect(Math.abs(now!.now - Date.now() / 1000)).toBeLessThan(60);
        await sql.exec(
          "CREATE TABLE lease (k TEXT PRIMARY KEY, owner TEXT NOT NULL, exp REAL NOT NULL) WITHOUT ROWID",
        );
        const upsert = (owner: string, ttl: number) =>
          sql.exec<{ owner: string }>(
            `INSERT INTO lease (k, owner, exp) VALUES ('g', ?, unixepoch('now', 'subsec') + ?)
             ON CONFLICT (k) DO UPDATE SET owner = excluded.owner, exp = excluded.exp
             WHERE lease.exp <= unixepoch('now', 'subsec')
             RETURNING owner`,
            owner,
            ttl,
          );
        expect((await upsert("a", 30)).rows.map(plain)).toEqual([{ owner: "a" }]);
        expect((await upsert("b", 30)).rows).toEqual([]);
        await sql.exec("UPDATE lease SET exp = unixepoch('now', 'subsec') - 1");
        expect((await upsert("c", 30)).rows.map(plain)).toEqual([{ owner: "c" }]);
        expect(
          await first(sql, "SELECT (1, 'b') > (1, 'a') AS gt, (1, 'a') < (1, 'a') AS lt"),
        ).toEqual({ gt: 1, lt: 0 });
      }));
  });
}
