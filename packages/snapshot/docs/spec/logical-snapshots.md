# Logical snapshots

The generated Durable Object exposes owner-local maintenance operations only on
its root `$collections`:

```ts
const stream = await this.$collections.$exportSnapshot();
const report = await this.$collections.$restoreSnapshot(stream);
await this.$collections.$resetAll();
```

These operations are absent from transaction-bound and action
`TrustedCollectionsApi` values, policy-bound collections, public clients, and
the Durable Object RPC method surface. A subclass that exposes them through
HTTP or RPC must provide its own authorization.

`@takibi/snapshot` owns the logical format, checksum, maintenance
schema, and lease algorithms. `takibi` keeps the typed document
lifecycle adapter that validates restored documents and prepares current seeds
until worker-runtime extraction.

## Format and transport

Version 1 is LF-terminated NDJSON:

```text
{"type":"header","format":"takibi.logical-snapshot","version":1,"collections":[...]}
{"type":"document","collection":"posts","id":"p1",...}
{"type":"trailer","counts":{"posts":1},"sha256":"..."}
```

The header lists every collection and its current document schema version in
UTF-8 name order. Documents follow in collection and ID UTF-8 order and contain
`id`, timestamps, stored schema version, revision, and domain data. The trailer
contains collection counts and SHA-256 over the exact emitted header and
document bytes, including their newlines.

Export reads one storage page in response to stream demand. It does not build
the complete snapshot in memory. Restore rejects records larger than 1 MiB,
invalid order or metadata, missing or inconsistent trailers, unsupported
collections or schema versions, and schema, index, or unique-constraint
violations before changing live documents.

The snapshot package owns only the logical format. Object storage, object
names, upload completion, compression, encryption, retention, and deletion
belong to the application. Snapshot data can include password hashes and
session tokens and must not be logged.

## Maintenance exclusion

Export, restore, and reset acquire one expiring maintenance lease. The active
Durable Object uses an in-memory gate for normal-operation checks, so ordinary
CRUD does not query SQLite for every operation. Maintenance admission closes
the gate before it begins and drains operations already in progress.

The durable lease is stored in `takibi_maintenance_lease` with:

- `lease_key`, whose only value is `global`
- `owner_token`
- `purpose`: `export`, `restore`, or `reset`
- `acquired_at` and `expires_at`, using SQLite's clock

Lease acquire, renewal, and owner-matched release are short SQLite
transactions. Stream page/chunk progress renews the lease. Expiry causes later
stream work to fail and never permits an old owner to release a successor's
lease. Activation removes abandoned leases and restore staging before serving
normal operations.

An internal in-memory backend implements the same lease, staging, scan, and
atomic-replacement contract for codec tests. It is not a root export or a
production Durable Object persistence option.

While a live lease exists, normal public, action, trusted, and transaction
operations, including reads that could trigger lazy migration, fail with
`MAINTENANCE_LOCKED` and status 503. Snapshot raw-storage work is scoped by the
owner token. Application code that accesses Durable Object storage directly is
outside this exclusion boundary.

## Restore and reset

Restore writes incoming documents to
`takibi_restore_staging_documents`. Unique-validation keys use the separate
snapshot-owned `takibi_restore_staging_unique` table. Staging rows are scoped
by owner token and never appear through collection APIs.

After complete format and document validation, one SQLite transaction deletes
live rows from `takibi_documents`, copies staged rows with their original
metadata, and inserts current-definition seeds whose IDs were absent from the
snapshot. A snapshot document wins an ID collision with a seed. Collections
added after the snapshot are restored as empty before current seeds are
applied.

Maintenance and snapshot failures use stable codes:

- `MAINTENANCE_LOCKED`: another maintenance window owns the store; retryable 503
- `SNAPSHOT_FORMAT`: invalid NDJSON, ordering, counts, checksum, or metadata
- `SNAPSHOT_INCOMPATIBLE`: unsupported format, collection, or schema version
- `SNAPSHOT_INVALID_DOCUMENT`: schema, index, or unique-constraint failure

`$resetAll()` validates current seeds and replaces only rows in
`takibi_documents` in one transaction. It does not call
`DurableObjectStorage.deleteAll()` and therefore does not remove
application-owned SQL tables, KV values, or other Durable Object storage.

The snapshot format version and Takibi's internal SQLite layout version are
independent.

This package owns all direct SQL and DDL for `takibi_maintenance_lease`,
`takibi_restore_staging_documents`, and `takibi_restore_staging_unique`.
Storage must not issue SQL against these private tables. Snapshot
initialization must be invoked before maintenance operations.
