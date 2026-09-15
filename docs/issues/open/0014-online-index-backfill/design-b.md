# Alternative: resumable migration while retaining expression indexes

## Example

Before: activation migrates every document and synchronously creates the index before any request is served.

After: activation registers resumable migration work; unindexed CRUD runs between bounded backfill chunks, and selected building indexes return INDEX_BUILDING 503. When migration finishes, CREATE INDEX still blocks the DO for a full physical scan. Thus this candidate cannot promise bounded availability throughout a 100,000-row rebuild.

## Design and tradeoffs

Persist descriptor/schema generation, migration cursor, state, and safe failures. Reuse expression SQL, existing tuple/order semantics, and native write maintenance. Build changed physical names before dropping old ones where possible; old indexes are not used for new descriptors/schema. Fence concurrent schema changes and restore/reset, and preserve immediately queryable successful restore just as in design A. Resume validation/migration after eviction, but physical CREATE INDEX remains one nonresumable phase.

This is a lower-cost partial mitigation if measurements show migration dominates and DDL duration is acceptable for the actual maximum partition. It preserves current physical representation and avoids sidecar write amplification/encoding risk. It is unsuitable if bounded progress of the full build is a hard requirement. Record observed DDL timing separately from migration timing before selecting it. A job state alone does not make SQLite DDL online.

Reuse A's concurrency, recovery, correctness, maintenance and failure tests, but explicitly measure the final blocked interval and revise acceptance only with a documented product decision. No such measurements or decision exist in this rethink; A remains the candidate aligned with the current full requirement.
