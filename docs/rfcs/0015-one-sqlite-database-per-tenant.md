---
id: "0015"
title: One single-writer SQLite database per tenant, on Durable Objects or one long-lived process
status: accepted
implementation: in-progress
created: 2026-11-13
decided: 2026-11-13
supersedes: ["0006"]
---

# One single-writer SQLite database per tenant

## Decision

A Takibi tenant is exactly one SQLite database with exactly one writer. Production
deployments may host tenants in one of two ways:

- **Cloudflare Durable Objects**, one SQLite-backed object per tenant. Unchanged and
  still first class.
- **One long-lived process that owns one database per tenant**, on Node >= 22.18. The
  database is a file opened with the built-in `node:sqlite` (`@takibi/node-sqlite`) or a
  libSQL database opened through `@libsql/client` (`@takibi/libsql`). Bun is not targeted
  yet, but nothing in the storage port depends on Node; a Bun connection would be one
  more first-party package.

| Backend        | One tenant database is                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| Durable Object | the SQLite storage of the object addressed by the tenant's name                    |
| SQLite file    | one file (plus its `-wal`/`-shm`) per tenant, in WAL mode with `synchronous=FULL`  |
| libSQL / Turso | one libSQL database per tenant: a local file, an embedded replica, or a remote URL |

Tenants never share a database, and no table carries a tenant column.

## Single writer

All writes to a tenant database go through one `SqlExecutor` in one process; it
serialises statements and transactions and is what makes application-level uniqueness
checks, the in-process maintenance controller, and commit fan-out to watch correct. On
Durable Objects the platform enforces this (one live instance per id). Outside Cloudflare
the Node host (not yet built) must enforce it: it opens each tenant at most once and
refuses to start while another process owns the database. Operators must not point two
deployments at the same file or Turso database. SQLite locks and `BEGIN IMMEDIATE` turn a
second writer into `SQLITE_BUSY` errors rather than corruption, but they do not restore
uniqueness, watch, or maintenance exclusion across processes.

## Guaranteed semantics

Every supported connection must pass one private conformance suite
(`@takibi/sql-conformance`), which runs the same tests on the Durable Object, `node:sqlite`,
and local libSQL connections. It covers the SQL port contract, transactions
([at most once, never replayed](../../packages/takibi/docs/spec/transactions.md), rollback,
nested joins), uniqueness, list results, cursors and isolation, layout migration, index
reconciliation, maintenance leases, and snapshot export, restore, and reset. These are
identical across backends. Watch is not yet available outside Durable Objects; it needs a
WebSocket host of its own.

## Remote connections and unknown commit outcomes

A libSQL connection may point at a remote URL. The adapter allows it, but every statement
becomes a network round trip, and because one tenant's statements run one at a time, a
tenant's throughput is bounded by round-trip time. An interactive transaction holds the
server's write lock from `BEGIN IMMEDIATE` until `COMMIT`, across every round trip and the
application callback in between; server-side transaction timeouts may abort long
callbacks. An embedded replica reads locally but, unless configured for offline writes,
sends writes to the primary, so its writes have the same costs.

When a connection cannot tell whether a commit (or an autocommit write) took effect, for
example because the response to `COMMIT` was lost, it rejects with the `TakibiError` code
`SQL_COMMIT_OUTCOME_UNKNOWN`. The executor, storage driver, and runtime pass it through
unchanged and never retry or replay. Commit observation treats it as possibly committed,
never as "nothing changed". Durable Objects and local SQLite know their commit outcome and
do not raise it.

Remote libSQL and embedded-replica sync are not exercised by the repository's tests, which
use local files and in-memory databases only; their behaviour above is taken from the
client's source and documentation.

## Driver contract stays private

`SqlConnection` remains an internal port of `@takibi/storage`, as RFC 0006 decided for the
storage seam. Applications choose a first-party connection package; there is no public
driver contract. The port's obligations (statement ordering, a transaction body invoked at
most once, value mapping, the unknown-outcome signal) are subtle, and promoting the port
later remains compatible while retracting it would not. The connection packages stay
`private` until the Node host gives them a use.

## Out of scope

- Stateless workers or several processes writing one tenant database. That needs
  database-enforced uniqueness, cross-process watch fan-out, and maintenance exclusion;
  [issue 0012](../issues/open/0012-turso-backend-feasibility/issue.md) still measures it.
- Shared-table multi-tenancy and database-per-user provisioning.
- Queue timeouts or cancellation in the executor.

## Implementation

In progress: the `node:sqlite` and libSQL connections, the unknown-outcome signal, and the
conformance suite exist. Still required: the Node host (tenant registry, startup
exclusion, lifecycle, public entry point) and watch over ordinary WebSockets.
