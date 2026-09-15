---
title: Materialize restored snapshots at the current schema before cutover
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Restore can report success while indexed queries silently omit valid documents, making the recovery point unreliable."
category: recovery
source_issue: 0057-restore-current-schema-indexability
---

# Problem

Logical snapshot restore validates an old-schema document by migrating it to the current collection
schema and checking schema, index fields, and unique constraints. The current lifecycle returns only
the extracted unique keys to `@takibi/snapshot`; the snapshot package then stages the original input
record. After cutover, the live table still contains the old `schema_version` and old JSON data.

An unindexed `get` can lazily migrate that row and return current data. An indexed list applies its
SQLite expression index and SQL predicate to the stored JSON first. If a migration introduced the
indexed field, the old row is absent from SQL results, so migration never runs and the first query
after a successful restore incorrectly returns no document.

Existing tests can miss the defect by calling `get("legacy")` before the indexed query. A recovery
point whose correctness depends on the first read path is not a completed restore.

# Proposal

Stage every accepted document in its migrated current-schema representation and atomically cut over
to rows whose stored schema version is the collection's current version. Preserve snapshot metadata
(`id`, `createdAt`, `updatedAt`, and `revision`) exactly; migration changes only domain data and the
stored schema version and does not increment revision.

Checksum and record counts continue to validate the canonical input snapshot stream. The manifest
version remains a compatibility check, not a promise to preserve old physical row versions after
restore.

# Package boundaries

- `@takibi/worker-runtime` owns collection-aware migration, schema/index validation, and conversion
  from the accepted input document to a current `SnapshotStoredDocument`.
- `@takibi/snapshot` owns stream validation, staging, uniqueness staging, maintenance leases, and
  atomic cutover. Extend `SnapshotLifecycle.validateRestoredDocument` (or replace it with a more
  accurately named preparation method) to return both the document to stage and its unique keys.
- `@takibi/storage` continues to own the live SQLite document/index layout. It must not learn
  application migration definitions.

The lifecycle result and staged unique keys must be derived from the same current document so a
validation value cannot diverge from the value eventually inserted.

# Implementation notes

- Convert the result of `validateStoredDocumentForRestore` with the existing snapshot-document
  helper using `currentCollectionVersion(definition)`.
- Pass the prepared current document, not the original parsed input, to
  `MaintenanceBackend.stageDocument`.
- Keep input timestamps and revision and strip internal version metadata from domain data.
- Update memory and SQLite maintenance backends only as required by the lifecycle contract; they
  should remain application-schema agnostic.
- Make the first post-restore operation in regression tests an indexed query, without a preceding
  get that could repair the row.
- Document that successful restore materializes the current schema.

# Scope

In scope:

- validation and current-schema staging of old-version logical snapshots;
- immediate indexed visibility after restore;
- exact metadata/revision preservation;
- snapshot, migration, and index integration tests.

Out of scope:

- changing snapshot wire format or checksum version;
- partial-collection restore;
- eagerly migrating every document during export;
- normal-traffic lazy migration or activation-time index backfill.

# Acceptance criteria

- Restoring a snapshot whose migration adds an indexed field makes the document visible to the first
  indexed list without an intervening get.
- Equality, range, order, and cursor queries use current-schema values immediately after restore.
- Raw restored rows contain current schema versions and migrated JSON.
- Snapshot `id`, timestamps, and revision match before and after restore.
- Migration, schema, index-field, and uniqueness failures leave live data unchanged.
- Unique staging keys are computed from exactly the current document that is staged.
- Re-exporting and restoring into a fresh object produces the same logical documents.
- `vp check`, snapshot tests, worker-runtime Node/Workers tests, and the repository-wide gate pass.
