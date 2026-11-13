import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vite-plus/test";
import { SqlExecutor, type SqlConnection, type SqlResult, type SqlRow } from "@takibi/storage";

const empty = <Row extends SqlRow>(): SqlResult<Row> => ({ rows: [], rowsWritten: 0 });

/**
 * A connection with the weakest behaviour an adapter may have: an outer
 * statement issued while a transaction is open joins it (as on one node:sqlite
 * connection or a Durable Object), and a second transaction while one is open
 * fails (as a second BEGIN does).
 */
function recordingConnection(): { connection: SqlConnection; log: string[] } {
  const log: string[] = [];
  let open = false;
  const connection: SqlConnection = {
    async exec<Row extends SqlRow>(query: string) {
      log.push(open ? `in-tx ${query}` : query);
      return empty<Row>();
    },
    async transaction(body) {
      if (open) throw new Error("cannot start a transaction within a transaction");
      open = true;
      log.push("BEGIN");
      try {
        const result = await body({
          async exec<Row extends SqlRow>(query: string) {
            log.push(`in-tx ${query}`);
            return empty<Row>();
          },
        });
        log.push("COMMIT");
        return result;
      } catch (error) {
        log.push("ROLLBACK");
        throw error;
      } finally {
        open = false;
      }
    },
  };
  return { connection, log };
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a statement issued while a transaction is open runs after it, never inside it", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor(connection);
  const transaction = sql.transaction(async (tx) => {
    await tx.exec("first");
    await macrotask();
    await tx.exec("second");
    throw new Error("roll back");
  });
  await macrotask();
  const outside = sql.exec("outside");
  await expect(transaction).rejects.toThrow("roll back");
  await outside;
  expect(log).toEqual(["BEGIN", "in-tx first", "in-tx second", "ROLLBACK", "outside"]);
});

test("transactions issued concurrently never overlap", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor(connection);
  const first = sql.transaction(async (tx) => {
    await macrotask();
    await tx.exec("a");
    return "a";
  });
  const second = sql.transaction(async (tx) => {
    await tx.exec("b");
    return "b";
  });
  await expect(Promise.all([first, second])).resolves.toEqual(["a", "b"]);
  expect(log).toEqual(["BEGIN", "in-tx a", "COMMIT", "BEGIN", "in-tx b", "COMMIT"]);
});

test("calls run in call order and a failure does not block later calls", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor({
    ...connection,
    async exec(query, ...bindings) {
      if (query === "bad") throw new Error("bad statement");
      return connection.exec(query, ...bindings);
    },
  });
  const results = await Promise.allSettled([
    sql.exec("one"),
    sql.exec("bad"),
    sql.transaction(async (tx) => tx.exec("two")),
    sql.exec("three"),
  ]);
  expect(results.map(({ status }) => status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
    "fulfilled",
  ]);
  expect(log).toEqual(["one", "BEGIN", "in-tx two", "COMMIT", "three"]);
});

test("the tx handle is scoped to its transaction", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor(connection);
  let calls = 0;
  const leaked = await sql.transaction(async (tx) => {
    calls += 1;
    await tx.exec("inside");
    return tx;
  });
  await expect(leaked.exec("after")).rejects.toMatchObject({ code: "SQL_TRANSACTION_CLOSED" });
  expect(calls).toBe(1);
  expect(log).toEqual(["BEGIN", "in-tx inside", "COMMIT"]);
});

const reentrant = { code: "SQL_REENTRANT_CALL" };

test("without an async context, a call reaching the executor before the callback's first await rejects at once", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor(connection);
  const outcome = await sql.transaction(async (tx) => {
    const statement = sql.exec("reentrant");
    const transaction = sql.transaction(async () => "unreached");
    await tx.exec("inside");
    return Promise.allSettled([statement, transaction]);
  });
  expect(outcome.map((result) => result.status === "rejected" && result.reason)).toEqual([
    expect.objectContaining(reentrant),
    expect.objectContaining(reentrant),
  ]);
  expect(log).toEqual(["BEGIN", "in-tx inside", "COMMIT"]);
});

test("with an async context, a call from anywhere inside the open callback rejects at once", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor(connection, { asyncContext: new AsyncLocalStorage() });
  const nested = async () => {
    await macrotask();
    return sql.exec("deep");
  };
  await expect(
    sql.transaction(async (tx) => {
      await tx.exec("first");
      await macrotask();
      await expect(sql.exec("after-await")).rejects.toMatchObject(reentrant);
      await expect(sql.transaction(async () => "unreached")).rejects.toMatchObject(reentrant);
      await expect(nested()).rejects.toMatchObject(reentrant);
      return "done";
    }),
  ).resolves.toBe("done");
  expect(log).toEqual(["BEGIN", "in-tx first", "COMMIT"]);
});

test("with an async context, independent calls still wait for the open transaction", async () => {
  const { connection, log } = recordingConnection();
  const sql = new SqlExecutor(connection, { asyncContext: new AsyncLocalStorage() });
  let later: Promise<unknown> | undefined;
  const transaction = sql.transaction(async (tx) => {
    await tx.exec("inside");
    await macrotask();
    // Work started here but run after the transaction settled is not reentrant.
    later = new Promise((resolve) => setTimeout(resolve, 5)).then(() => sql.exec("later"));
    return "committed";
  });
  await macrotask();
  const outside = sql.exec("outside");
  await expect(transaction).resolves.toBe("committed");
  await outside;
  await later;
  expect(log).toEqual(["BEGIN", "in-tx inside", "COMMIT", "outside", "later"]);
});

test("an async context store is scoped per executor", async () => {
  const context = new AsyncLocalStorage();
  const first = new SqlExecutor(recordingConnection().connection, { asyncContext: context });
  const second = recordingConnection();
  const other = new SqlExecutor(second.connection, { asyncContext: context });
  await first.transaction(async () => {
    await macrotask();
    await expect(other.exec("other database")).resolves.toBeDefined();
    await expect(other.transaction(async () => first.exec("back"))).rejects.toMatchObject(
      reentrant,
    );
  });
  expect(second.log).toEqual(["other database", "BEGIN", "ROLLBACK"]);
});
