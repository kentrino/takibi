import { expect, test } from "vite-plus/test";
import { SqliteMaintenanceBackend } from "@takibi/snapshot";
import { createSqliteStorage, type SqlConnection } from "@takibi/storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";

// The storage driver and the maintenance backend share one SQL executor. A
// driver write issued while a maintenance transaction is open must neither land
// inside it nor be rolled back with it.

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Yields to the event loop before the restore's document wipe, inside its transaction. */
function slowRestoreWipe(connection: SqlConnection): SqlConnection {
  return {
    ...connection,
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

test("a driver write during a failing restore transaction survives its rollback", async () => {
  const sql = createNodeSqliteExecutor(slowRestoreWipe);
  const storage = createSqliteStorage(sql);
  await storage.initialize();
  const backend = new SqliteMaintenanceBackend(sql);
  await backend.cleanupAbandoned();
  const document = (id: string) => ({
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: id,
  });
  await storage.put("posts", document("before"));
  const lease = await backend.acquire("owner", "restore", 30);
  expect(lease).toBeDefined();

  // No seeds are inserted, so the expected count of one fails after the wipe.
  const restore = backend.finalizeRestore("owner", [], 1);
  await macrotask();
  const write = storage.put("posts", document("during"));

  await expect(restore).rejects.toThrow("Seed reconciliation count mismatch");
  await write;
  const ids = (await storage.list("posts")).items.map(({ id }) => id);
  expect(ids).toEqual(["before", "during"]);
  sql.close();
});
