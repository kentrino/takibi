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
  database is a file opened with the built-in `node:sqlite` (`@takibi/node-sqlite`), or a
  local file or remote libSQL server opened through `@libsql/client` (`@takibi/libsql`).
  Bun is not targeted yet, but nothing in the storage port depends on Node; a Bun
  connection would be one more first-party package.

| Backend        | One tenant database is                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| Durable Object | the SQLite storage of the object addressed by the tenant's name                   |
| SQLite file    | one file (plus its `-wal`/`-shm`) per tenant, in WAL mode with `synchronous=FULL` |
| libSQL / Turso | one libSQL database per tenant: a local file, or a remote server over HTTP        |

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
local libSQL, and remote libSQL (against a local `sqld`) connections. It covers the SQL
port contract, transactions
([at most once, never replayed](../../packages/takibi/docs/spec/transactions.md), rollback,
nested joins), uniqueness, list results, cursors and isolation, layout migration, index
reconciliation, maintenance leases, and snapshot export, restore, and reset. These are
identical across backends.

List watches (`takibi/watch`) are supported on the Durable Object backend only. A host
without a watch capability gets no commit fan-out, and the tenant runtime refuses every
watch upgrade with `WATCH_UNAVAILABLE` (400; `upgradeWatch` in
`packages/worker-runtime/src/tenant-runtime.ts`).

## Remote connections and unknown commit outcomes

A libSQL connection may point at a remote server over HTTP (`libsql:`, `https:`). Every
statement becomes a network round trip, and because one tenant's statements run one at a
time, a tenant's throughput is bounded by round-trip time. An interactive transaction holds
the server's write lock from `BEGIN IMMEDIATE` until `COMMIT`, across every round trip and
the application callback in between; server-side transaction timeouts may abort long
callbacks. A remote database gets no session `PRAGMA`s: each HTTP request runs on its own
server stream, so one would not outlive its request; durability settings are the server's.

When a connection sent a write and cannot tell whether it was committed (the response to
`COMMIT`, or to an autocommit write, was lost), it rejects with the `TakibiError` code
`SQL_COMMIT_OUTCOME_UNKNOWN`. Reads and statements inside an open transaction commit
nothing by themselves, so their failures are ordinary errors; the engine marks its reads
outside transactions so the connection can tell them apart. The libSQL connection treats a
remote failure as proof that nothing committed only when the client reports a SQLite result
code (`SQLITE_*`) or refused to send `COMMIT`; anything else is unknown. The executor, storage driver, and runtime pass
the error through unchanged and never retry or replay. Commit observation treats it as
possibly committed, never as "nothing changed". Durable Objects and local SQLite know their
commit outcome and do not raise it.

Remote behaviour is tested against a local `sqld` 0.24.32 (conformance plus lost requests,
lost responses, and a killed server), when the test run is given the binary; Turso Cloud is
not exercised.

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
- Watch outside Durable Objects; revisit when there is demand. It is not free: the watch
  socket registry and its lifecycle are the Hibernation API, so another host would need its
  own socket registry, recovery, and shutdown.
- Queue timeouts or cancellation in the executor.
- libSQL embedded replicas (a local file synced with a remote primary). Writes go to the
  primary while reads are local and may lag, which is a different consistency model from
  the single database this RFC assumes, and they need the native client and a local file.
  Nothing depends on them; revisit with a use and real tests.
- libSQL over WebSockets; only HTTP is tested.

## Implementation

In progress: the `node:sqlite` and libSQL (local and remote) connections, the
unknown-outcome signal, and the conformance suite exist. Still required: the Node host
(tenant registry, startup exclusion, lifecycle, public entry point).
