# `@takibi/libsql`

Takibi SQL connection over the libSQL client (`@libsql/client` 0.18.0), for one libSQL or
Turso database per tenant owned by one process ([RFC 0015](../../docs/rfcs/0015-one-sqlite-database-per-tenant.md)).

```ts
import { openLibsqlExecutor } from "@takibi/libsql";

const sql = await openLibsqlExecutor({ url: "file:/var/lib/app/tenants/acme.db" });
// ... hand `sql` to the tenant runtime; after it closed:
sql.close();
```

| URL                                  | Location | Notes                                                        |
| ------------------------------------ | -------- | ------------------------------------------------------------ |
| `file:...`, `:memory:`               | `local`  | WAL, `synchronous=FULL`, `foreign_keys=ON`                   |
| `libsql:`, `https:`, `http:` + token | `remote` | every statement is a round trip; server settings, no pragmas |

Embedded replicas (`syncUrl`), WebSocket URLs and other client options are refused.
`libsqlConnection(client, "remote")` wraps a client created elsewhere, such as
`@libsql/client/web` inside a Cloudflare Worker.

The connection reads integers as numbers (`intMode: "number"`; an unsafe integer
rejects) and uses one client connection. Transactions use `write` mode (`BEGIN
IMMEDIATE`); against a remote database an open transaction holds the server's write lock
across round trips. A remote `COMMIT`, or an autocommit write, that fails without a SQLite
result code (`LibsqlError.code` `SQLITE_*`) proving it was rejected rejects with
`SQL_COMMIT_OUTCOME_UNKNOWN`. Reads and statements inside a transaction fail as
themselves. Neither this package nor `@libsql/client` 0.18.0 retries a statement or a
commit; re-check that, and the error codes the classification relies on, when upgrading
the client.

The package is private: the storage port is internal, and the connection has no use
until a host exists. It must pass the shared `@takibi/sql-conformance` suite, which runs
here against local files and `:memory:`.
