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
