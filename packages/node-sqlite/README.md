# `@takibi/node-sqlite`

Takibi SQL connection over Node's built-in `node:sqlite` (Node >= 22.18), for one
tenant database file owned by one process ([RFC 0015](../../docs/rfcs/0015-one-sqlite-database-per-tenant.md)).

```ts
import { openNodeSqliteExecutor } from "@takibi/node-sqlite";

const sql = openNodeSqliteExecutor("/var/lib/app/tenants/acme.sqlite");
// ... hand `sql` to the tenant runtime; after it closed:
sql.close();
```

`openNodeSqliteConnection(location, options)` returns the raw `SqlConnection`;
`openNodeSqliteExecutor` wraps it in a `SqlExecutor` that detects reentrant calls with
`AsyncLocalStorage`. A file database runs in WAL mode with `synchronous=FULL`,
`foreign_keys=ON`, and a busy timeout of 0 unless `busyTimeoutMs` says otherwise;
transactions use `BEGIN IMMEDIATE`. Keep the `-wal` and `-shm` files with the database.

The package is private: the storage port is internal, and the connection has no use
until the Node host exists. It must pass the shared `@takibi/sql-conformance` suite.
`@takibi/testing` uses it for its in-memory test databases.
