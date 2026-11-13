# `@takibi/sql-conformance`

The test suite every Takibi SQL connection must pass ([RFC 0015](../../docs/rfcs/0015-one-sqlite-database-per-tenant.md)).
Private and test-only: it registers Vitest tests and is never published.

```ts
import { describeSqlConformance } from "@takibi/sql-conformance";

describeSqlConformance("my backend", {
  async withDatabase(name, body) {
    const sql = openFreshExecutor(name); // a new, empty database
    try {
      await body(sql);
    } finally {
      closeIt(sql);
    }
  },
});
```

It covers the SQL port contract and the SQLite features the engine uses (JSON1,
`WITHOUT ROWID`, partial expression indexes, `RETURNING`, `unixepoch('now','subsec')`,
upsert with `WHERE`, row values, transactional DDL), the storage driver (lists, cursors,
isolation, revisions, layout, index reconciliation), the transaction callback no-replay
contract (RFC 0003) across every storage wrapper, and the tenant runtime (seeds,
uniqueness under concurrency, trusted transactions, maintenance lease, snapshot export,
reset, and restore).

Where it runs:

| Connection     | Test file                                          |
| -------------- | -------------------------------------------------- |
| Durable Object | `packages/takibi/tests/sql-conformance.workers.ts` |
| `node:sqlite`  | `packages/node-sqlite/tests/conformance.test.ts`   |

The package depends on the engine packages (including `@takibi/worker-runtime` for the
tenant runtime) and on no connection, so each connection package can run it without a
dependency cycle.
