# Design A: Prepare current-schema documents before cutover

Status: implemented.

## Contract

A successful restore publishes documents validated and stored in the current collection schema.
Every read path must observe the same logical data immediately after cutover. Migration preserves
collection, ID, timestamps, and revision; only domain data and stored schema version change.

## Approach

Replace `SnapshotLifecycle.validateRestoredDocument` with `prepareRestoredDocument`, returning the
document to stage together with unique keys derived from that exact current document.

1. The snapshot package validates input format, metadata, collection membership, and ordering.
2. The worker-runtime adapter migrates and validates domain data using
   `validateStoredDocumentForRestore`, checks index fields, and prepares both the stored document
   and unique keys. Use `toSnapshotDocument` with `currentCollectionVersion(definition)` to preserve
   metadata and exclude internal version metadata from domain data.
3. The snapshot package stages the returned document and unique keys. Checksums and record counts
   continue to cover the original input stream.
4. After complete validation and seed reconciliation, the existing transaction replaces live rows.
   Existing SQLite expression indexes reflect the inserted current-schema values.

Preparation runs once per input document, including documents already at the current version.
Do not validate one representation and then rerun migration to produce another for storage.

## API Example

The package lifecycle API changes; the application `$restoreSnapshot(stream)` API does not.
Use one prepared-document shape for restore and seeds, retaining `SnapshotSeed` as a type alias:

```ts
export type SnapshotPreparedDocument = {
  document: SnapshotStoredDocument;
  uniqueConstraints: readonly SnapshotUniqueConstraint[];
};

export type SnapshotSeed = SnapshotPreparedDocument;

export type SnapshotLifecycle = {
  listCollections(): readonly SnapshotCollectionDescriptor[];
  prepareRestoredDocument(document: SnapshotStoredDocument): Promise<SnapshotPreparedDocument>;
  prepareSeeds(): Promise<readonly SnapshotSeed[]>;
};
```

The restore pipeline consumes the prepared value:

```ts
const prepared = await lifecycle.prepareRestoredDocument(input);
await stageUniqueConstraints(maintenance, lease, prepared.uniqueConstraints);
await maintenance.backend.stageDocument(lease.token, prepared.document);
```

For example, an input at version 0 with `data: { title: "Migrated" }` is staged at version 1
with `data: { slug: "migrated" }` when the migration introduces `slug`. Its identity, timestamps,
and revision remain identical, and the first `bySlug` query can find it.

Update lifecycle implementations, callers, test doubles, and package type exports together.

## Ownership and scope

- `@takibi/worker-runtime` owns collection-aware preparation and validation.
- `@takibi/snapshot` owns stream integrity, staging, uniqueness checks, leases, and atomic cutover.
- `@takibi/storage` owns live document and index layout without application migration knowledge.

This needs no new package or general migration framework. Keep existing error mapping and atomic
failure behavior. Document current-schema materialization in the snapshot specification; neither
the wire format nor its checksum version changes. Re-export may have different bytes and schema
versions while preserving logical documents and metadata.

## Alternatives and follow-up

Query-time repair must handle filtering, ordering, and cursors over mixed schema versions and would
add complexity to normal reads. Post-cutover backfill would expose an incomplete restore or require
an additional readiness phase. Preparing during existing staging closes the gap before publication.

[Online index backfill](../../open/0014-online-index-backfill/issue.md) addresses activation scalability and
can proceed independently. If indexes move to sidecar tables, restore/reset must also prepare or
invalidate their generations atomically so that a ready index covers the newly published dataset.

## Verification

- Make the first post-restore collection operation an indexed query, without a repairing `get`.
  Cover added and changed index values, equality, range, ordering, and cursor pagination.
- Inspect raw rows for current schema versions and migrated data; verify exact metadata preservation.
- Check that staged unique keys match staged data, including migration-induced collisions and seeds.
- Migration, schema, index-field, uniqueness, and stream-integrity failures leave live data unchanged.
- With fixed definitions, seeds, and deterministic schema/migration transforms, re-export and restore
  into a fresh object preserve logical documents and metadata; byte equality is not required.
- Run snapshot tests, the SQLite-backed restore integration tests, relevant Workers tests, `vp check`,
  and the repository-wide gate.
