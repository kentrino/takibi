import { expect, test } from "vite-plus/test";
import { SqliteMaintenanceBackend } from "@takibi/snapshot";
import { openSqliteStorage, type SqlConnection } from "@takibi/storage";
import {
  createSqliteDurableObjectStorage,
  type SqliteDurableObjectStorage,
} from "@takibi/testing/durable-object-storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";
import { createDurableObjectSqlExecutor } from "../src/durable-object-sql";

// The storage driver and the maintenance backend share one SQL executor. A
// driver write issued while a maintenance transaction is open must neither land
// inside it nor be rolled back with it, on either adapter.

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Yields to the event loop before the restore's document wipe, inside its transaction. */
function slowRestoreWipe(connection: SqlConnection): SqlConnection {
  return {
    exec: (query, ...bindings) => connection.exec(query, ...bindings),
    transaction: (body) =>
      connection.transaction((tx) =>
        body({
          async exec(query, ...bindings) {
            if (query === "DELETE FROM takibi_documents") await macrotask();
            return tx.exec(query, ...bindings);
          },
        }),
      ),
  };
}

/**
 * Yields to the event loop at the start of every Durable Object transaction,
 * after it began, so the production adapter itself must keep other statements
 * out of it.
 */
function slowDurableTransactions(storage: SqliteDurableObjectStorage): DurableObjectStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver) as unknown;
      return <T>(closure: (transaction: DurableObjectTransaction) => Promise<T>) =>
        target.transaction(async (transaction) => {
          // Longer than the test's own yield, so its write arrives while this is open.
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return closure(transaction);
        });
    },
  });
}

const adapters = {
  "node:sqlite": () => {
    const sql = createNodeSqliteExecutor(slowRestoreWipe);
    return { sql, close: () => sql.close() };
  },
  "Durable Object": () => {
    const storage = createSqliteDurableObjectStorage();
    const sql = createDurableObjectSqlExecutor(slowDurableTransactions(storage));
    return { sql, close: () => storage.close() };
  },
};

for (const [name, open] of Object.entries(adapters)) {
  test(`${name}: a driver write during a failing restore transaction survives its rollback`, async () => {
    const { sql, close } = open();
    const storage = (await openSqliteStorage(sql)).storage;
    const backend = await SqliteMaintenanceBackend.open(sql);
    await backend.cleanupAbandoned();
    const document = (id: string) => ({
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: id,
    });
    await storage.put("posts", document("before"));
    expect(await backend.acquire("owner", "restore", 30)).toBeDefined();

    // No seeds are inserted, so the expected count of one fails after the wipe.
    const restore = backend.finalizeRestore("owner", [], 1);
    await macrotask();
    const write = storage.put("posts", document("during"));

    await expect(restore).rejects.toThrow("Seed reconciliation count mismatch");
    await write;
    const ids = (await storage.list("posts")).items.map((item) => item.id);
    expect(ids).toEqual(["before", "during"]);
    close();
  });
}
