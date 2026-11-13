# `@takibi/libsql`

Takibi SQL connection over the libSQL client (`@libsql/client` 0.18.0), for one libSQL or
Turso database per tenant owned by one process ([RFC 0015](../../docs/rfcs/0015-one-sqlite-database-per-tenant.md)).

```ts
import { openLibsqlExecutor } from "@takibi/libsql";

const sql = await openLibsqlExecutor({ url: "file:/var/lib/app/tenants/acme.db" });
// ... hand `sql` to the tenant runtime; after it closed:
sql.close();
```

| URL                                 | Location  | Notes                                                    |
| ----------------------------------- | --------- | -------------------------------------------------------- |
| `file:...`, `:memory:`              | `local`   | WAL, `synchronous=FULL`, `foreign_keys=ON`; tested       |
| `file:...` with `syncUrl`           | `replica` | embedded replica; writes go to the primary; **untested** |
| `libsql:`, `https:`, `wss:` (Turso) | `remote`  | every statement is a round trip; **untested**            |

The connection reads integers as numbers (`intMode: "number"`; an unsafe integer
rejects) and uses one client connection. Transactions use `write` mode (`BEGIN
IMMEDIATE`); against a remote database an open transaction holds the server's write lock
across round trips. A remote or replica commit (or autocommit write) that fails without
proof that it did not take effect rejects with `SQL_COMMIT_OUTCOME_UNKNOWN`. Neither this
package nor `@libsql/client` 0.18.0 retries a statement or a commit; re-check that when
upgrading the client.

The package is private: the storage port is internal, and the connection has no use
until the Node host exists. It must pass the shared `@takibi/sql-conformance` suite,
which runs here against local files and `:memory:` only.
