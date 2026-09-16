# Resumable generation backfill with a side table

## Decision and evidence

Keep open; prefer this structural candidate if bounded activation for large partitions is required. `index-reconcile.ts` drops changed indexes, scans migration/validation pages of 200 to completion, then invokes CREATE INDEX. `durable-object.ts` awaits it in constructor blockConcurrencyWhile. The ready-only catalog has no durable progress. These are confirmed mechanisms; a production outage or activation-time benchmark has not been reproduced. SQL expression-index creation itself scans the table, so batching only migration cannot meet the whole requirement.

The original physical-index choice's rationale is not documented by the inspected recent history. Current constraints are explicit typed selection, index validation, cursor semantics, and synchronous SQLite DDL. Snapshot fixes `106c124`/`effae04` establish immediately queryable restore and immutable restored identity; the new state machine must preserve those guarantees. [Alternative B](./design-b.md) retains expression indexes and reduces part of the delay, with a stated limit.

## Example

Before: deploy an added/changed typed index; activation awaits full migration plus CREATE INDEX before `get`, writes, or indexed list can run.

After (proposed observable contract): unindexed `api.items.get(id)` and normal add/update work after bounded initialization. A list explicitly selecting a generation that is building returns a safe retryable `INDEX_BUILDING` error, status 503, instead of a partial page or silent fallback. Retrying the same request after readiness returns the normal ordered page. A changed descriptor/schema cannot use the old generation merely because it remains physically present. Existing index selection syntax stays unchanged.

## Responsibilities and state

Storage owns a sidecar entry table, canonical order-preserving tuple encoding, a generation catalog, transactional write maintenance, indexed scan primitives, and bounded backfill. Runtime owns constructor registration, shared DO alarm scheduling, migration callbacks, diagnostics, and error mapping. One DO has one alarm; integrate with a single maintenance scheduler rather than overwriting another task's alarm. No new package or global partition worker is necessary.

Persist collection/public index identity, immutable physical generation, descriptor hash, schema version, pending/building/ready/failed state, scan cursor, and sanitized error. Entries are keyed by collection, generation, tuple, document id. Use a stable document-id backfill cursor, independent of mutable index tuples. A chunk reads current rows, migrates/validates, upserts sidecar entries, and advances progress atomically; a single unbounded migration callback remains a risk even with row budgets. Bound both work count and measured duration where runtime permits.

All put/delete paths, including add/set/update, lazy migration, restore/import and transaction-scoped writes, must maintain relevant generations in the same transaction. Scanning plus dual writes covers inserts behind the cursor; deleting or changing a tuple removes the old entry rather than leaving duplicates. Promotion checks completed progress and desired descriptor/schema in one transaction. Descriptor changes during a build cancel/supersede the obsolete job; stale alarms cannot promote it.

Keep the previous ready generation until safe promotion/cleanup. It remains usable only for the descriptor and schema it actually represents; changed application queries receive readiness failure. If supporting two descriptors' write validation simultaneously is impossible, old generation retention serves rollback/cleanup rather than old-query availability. Do not claim zero downtime for explicit changed-index queries.

Migration/field errors mark that build failed, preserve safe diagnostics, and do not block unrelated unindexed CRUD. Building requests use INDEX_BUILDING; failed generation requests should use a separately specified safe failure response, not imply that retry always succeeds. Provide an explicit maintenance retry or a bounded later-activation retry with attempt state/backoff, avoiding a hot alarm failure loop. The exact operator-facing retry interface must be selected and documented during implementation; no new public escape hatch for raw SQL is intended.

## Physical compatibility and maintenance

Prove tuple equivalence for strings (including Unicode), finite numbers, direction, metadata, equality prefixes, ranges, id tie-breaks, and residual filtering before switching reads. Version cursor representation/binding to reject incompatible old cursors explicitly rather than reuse positions with different meaning. Build sidecar generations alongside existing expression indexes; only switch the ready mapping atomically after complete population, then reclaim obsolete entries/indexes in bounded work. New side-table DDL must create empty structures rather than another full-document expression-index scan.

Restore/reset is a required participant. Existing snapshot semantics require immediate queryability after successful restore; a restored partition cannot merely return success then leave indexes building. Either populate and promote required sidecars within restore's maintenance boundary before success, or explicitly redesign restore in a separate approved contract change. Reset cancels persisted jobs/cursors and clears catalog/entries with documents; stale alarm work must be fenced by a maintenance generation. Snapshot export should not depend on exporting physical sidecars if they are reproducible, but this must match existing snapshot format and restart behavior.

## Alternatives, validation, and unknowns

The ideal design from scratch separates desired index metadata from resumable physical generation state. Sidecars achieve bounded construction but add tuple/maintenance complexity and write amplification. Keeping expression indexes (B) is less risky for ordering and storage usage but retains an unbounded DDL phase. Doing nothing is reasonable for small partitions; it does not satisfy the confirmed structural limit for large ones. Do not combine count or general nonindexed migration redesign into this issue.

Required acceptance: a 100,000-document-equivalent fixture performs no full scan during activation, ordinary get/add/update stay available, alarms resume after eviction, and promotion yields exactly the existing equality/range/order/direction/cursor contract. Failure injection covers interrupted chunk/alarms, concurrent insert/update/delete/lazy migration, isolate recreation, schema/descriptor changes, immediately-before-promotion failure, failed-build retry, restore/reset, and safe layout upgrade. Verify no partial ready mapping or duplicated/omitted results. Run `vp check`, storage and runtime Workers tests, and repository-wide gate after implementation.

Unverified: tuple encoding size/cost, job duration versus DO limits, write amplification, migration callback cost, and exact alarm coexistence need measurements/probes before committing to the implementation plan. If sidecar parity or operational cost is unacceptable, retain B's explicit limitation and revisit the availability target; do not report B as completing bounded activation. This rethink inspected code/history and did not run the large fixture, external runtime-limit research, or implementation tests.
