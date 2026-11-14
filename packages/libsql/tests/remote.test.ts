import { LibsqlError } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { describeSqlConformance } from "@takibi/sql-conformance";
import { isSqlCommitOutcomeUnknown, openSqliteStorage, type StoredDocument } from "@takibi/storage";
import { openLibsqlExecutor, type LibsqlExecutor } from "@takibi/libsql";
import { FaultProxy, SQLD_BIN, Sqld } from "./sqld";

// Remote libSQL against a real local server (sqld) over Hrana-over-HTTP.
// Runs only when TAKIBI_SQLD names an sqld binary; otherwise every test
// below is reported as skipped. See the package README.
const suite = SQLD_BIN === undefined ? describe.skip : describe;
const title =
  SQLD_BIN === undefined
    ? "remote libSQL (sqld): skipped, set TAKIBI_SQLD to an sqld binary"
    : "remote libSQL (sqld)";

const doc = (id: string): StoredDocument => ({
  id,
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T00:00:00.000Z",
  title: id,
});

suite(title, () => {
  const sqld = new Sqld();
  const proxy = new FaultProxy(() => sqld.httpPort);
  beforeAll(async () => {
    await sqld.start();
    await proxy.start();
  });
  afterAll(async () => {
    await proxy.stop();
    await sqld.stop();
  });

  describeSqlConformance("libSQL remote (sqld over HTTP)", {
    async withDatabase(name, body) {
      const sql = await openLibsqlExecutor({ url: sqld.url(await sqld.createDatabase(name)) });
      try {
        expect(sql.location).toBe("remote");
        await body(sql);
      } finally {
        sql.close();
      }
    },
  });

  describe("failures are classified on the real client and server", () => {
    /** A fresh database, reached directly and through the fault proxy. */
    async function database(name: string) {
      const namespace = await sqld.createDatabase(name);
      const direct = await openLibsqlExecutor({ url: sqld.url(namespace) });
      const faulty = await openLibsqlExecutor({ url: sqld.url(namespace, proxy.port) });
      const storage = await openSqliteStorage(faulty);
      const committed = async (id: string) =>
        (
          await direct.read<{ n: number }>(
            "SELECT count(*) AS n FROM takibi_documents WHERE collection = 'posts' AND id = ?",
            id,
          )
        ).rows[0]!.n === 1;
      const close = () => {
        direct.close();
        faulty.close();
      };
      return { direct, faulty, storage, committed, close };
    }

    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved" as const,
        (error: unknown) => error,
      );

    test("a read whose request or response is lost fails as itself", async () => {
      const db = await database("read-lost");
      try {
        await db.storage.put("posts", doc("a"));
        for (const lose of ["request", "response"] as const) {
          const struck = proxy.arm({ match: "FROM takibi_documents", lose });
          const error = await outcome(db.storage.get("posts", "a"));
          await struck;
          expect(error, lose).toBeInstanceOf(Error);
          expect(isSqlCommitOutcomeUnknown(error), lose).toBe(false);
        }
        await expect(db.storage.get("posts", "a")).resolves.toMatchObject({ id: "a" });
      } finally {
        db.close();
      }
    });

    test("an autocommit write whose response is lost is unknown, and did commit", async () => {
      const db = await database("write-response-lost");
      try {
        const struck = proxy.arm({ match: "INSERT INTO takibi_documents", lose: "response" });
        const error = await outcome(db.storage.put("posts", doc("w")));
        await struck;
        expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
        expect(await db.committed("w")).toBe(true);
      } finally {
        db.close();
      }
    });

    test("an autocommit write whose request is lost is unknown too, and did not commit", async () => {
      // The client cannot tell a request that never arrived from a lost
      // response, so it errs towards unknown.
      const db = await database("write-request-lost");
      try {
        const struck = proxy.arm({ match: "INSERT INTO takibi_documents", lose: "request" });
        const error = await outcome(db.storage.put("posts", doc("w")));
        await struck;
        expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
        expect(await db.committed("w")).toBe(false);
      } finally {
        db.close();
      }
    });

    test("an autocommit write the server's SQLite rejects is an ordinary failure", async () => {
      const db = await database("write-rejected");
      try {
        await db.faulty.exec("CREATE TABLE t (k TEXT PRIMARY KEY) WITHOUT ROWID");
        await db.faulty.exec("INSERT INTO t VALUES ('a')");
        const error = await outcome(db.faulty.exec("INSERT INTO t VALUES ('a')"));
        expect(error).toBeInstanceOf(LibsqlError);
        expect((error as LibsqlError).code).toBe("SQLITE_CONSTRAINT");
      } finally {
        db.close();
      }
    });

    test("a statement inside a transaction whose response is lost fails as itself", async () => {
      const db = await database("statement-lost");
      try {
        let bodies = 0;
        const struck = proxy.arm({ match: "INSERT INTO takibi_documents", lose: "response" });
        const error = await outcome(
          db.storage.transaction(async (tx) => {
            bodies += 1;
            await tx.put("posts", doc("s"));
          }),
        );
        await struck;
        expect(bodies).toBe(1);
        expect(error).toBeInstanceOf(Error);
        expect(isSqlCommitOutcomeUnknown(error)).toBe(false);
        expect(await db.committed("s")).toBe(false);
      } finally {
        db.close();
      }
    });

    test("a COMMIT whose response is lost is unknown, attempted once, and did commit", async () => {
      const db = await database("commit-response-lost");
      try {
        let bodies = 0;
        const struck = proxy.arm({ match: "COMMIT", lose: "response" });
        const error = await outcome(
          db.storage.transaction(async (tx) => {
            bodies += 1;
            await tx.put("posts", doc("c"));
          }),
        );
        await struck;
        expect(bodies).toBe(1);
        expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
        expect(await db.committed("c")).toBe(true);
      } finally {
        db.close();
      }
    });

    test("a COMMIT whose request is lost is unknown, and did not commit", async () => {
      const db = await database("commit-request-lost");
      try {
        const struck = proxy.arm({ match: "COMMIT", lose: "request" });
        const error = await outcome(db.storage.transaction((tx) => tx.put("posts", doc("c"))));
        await struck;
        expect(isSqlCommitOutcomeUnknown(error)).toBe(true);
        expect(await db.committed("c")).toBe(false);
      } finally {
        db.close();
      }
    });
  });
});

suite(`${title}: server killed`, () => {
  const sqld = new Sqld();
  let sql: LibsqlExecutor | undefined;
  beforeAll(() => sqld.start());
  afterAll(async () => {
    sql?.close();
    await sqld.stop();
  });

  test("reads fail as themselves and an open transaction is lost, never unknown", async () => {
    const namespace = await sqld.createDatabase("killed");
    sql = await openLibsqlExecutor({ url: sqld.url(namespace) });
    const storage = await openSqliteStorage(sql);
    await storage.put("posts", doc("before"));

    // Killed mid-transaction: the statement after the kill fails as itself.
    let bodies = 0;
    const error = await storage
      .transaction(async (tx) => {
        bodies += 1;
        await tx.put("posts", doc("inside"));
        await sqld.kill();
        await tx.get("posts", "before");
      })
      .then(
        () => "resolved",
        (caught: unknown) => caught,
      );
    expect(bodies).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(isSqlCommitOutcomeUnknown(error)).toBe(false);

    // Killed: a read fails as itself.
    const read = await storage.get("posts", "before").catch((caught: unknown) => caught);
    expect(read).toBeInstanceOf(Error);
    expect(isSqlCommitOutcomeUnknown(read)).toBe(false);

    // Restarted on the same data: the committed write is there, the open
    // transaction's is not.
    await sqld.start();
    await expect(storage.get("posts", "before")).resolves.toMatchObject({ id: "before" });
    await expect(storage.get("posts", "inside")).resolves.toBeNull();
  });
});
