---
title: Replace blocking index activation with resumable online backfill
author: OpenAI Codex
cost: 8
priority: P2
priority_reason: "Large partitions can enter long cold-start stalls or repeated activation failure, but the redesign is substantial and should follow core correctness fixes."
category: scalability
source_issue: 0058-online-index-backfill
---

# Problem

When a typed index is added or changed, or an indexed collection's schema version advances, the
generated Durable Object runs `reconcileCollectionIndexes` inside constructor
`blockConcurrencyWhile`. Reconciliation migrates the collection and creates a SQLite expression
index before the object accepts requests.

Activation latency and CPU grow with document count. Failure restarts the work from the beginning on
the next activation, so a large partition can suffer full unavailability or an activation-failure
loop after an ordinary schema/index deployment. The current catalog represents ready indexes only;
it cannot persist building state, generation, progress, or failure.

SQLite `CREATE INDEX` itself performs a synchronous table scan. Splitting only the migration loop
does not remove the blocking scan while expression indexes remain the physical representation.

# Proposal

Move typed index storage from expression indexes over `takibi_documents` to a Takibi-managed sidecar
entry table. Give each physical generation persisted `pending`, `building`, `ready`, or `failed`
state and a resumable cursor. Build entries in bounded transactions.

Normal document reads/writes and unindexed list remain available while a generation builds. A query
that explicitly selects the building index returns retryable `INDEX_BUILDING` status 503 rather than
an incomplete result or silent unindexed fallback. Promotion to ready is atomic and occurs only
after the backfill reaches the end and all writes during the build have updated the same generation.

Constructor initialization performs only bounded layout/catalog validation and build-job
registration inside `blockConcurrencyWhile`. Continue work through a Durable Object alarm and/or a
bounded amount of work after later requests. Persist enough state to resume after isolate eviction
or deployment. Because one Durable Object has one alarm, index scheduling must coexist with any
other alarm-owned maintenance through one explicit scheduler.

# Package boundaries

- `@takibi/storage` owns sidecar schema, tuple encoding, generation catalog, write maintenance,
  indexed scans, and bounded backfill primitives.
- `@takibi/worker-runtime` owns Durable Object initialization, alarm dispatch/scheduling, error
  mapping, logging/tracing context, and collection migration callbacks used during backfill.
- `@takibi/api` and `@takibi/query` retain the existing typed index and query contracts; no automatic
  planner is added.

# Implementation notes

- Persist generation, state, cursor, sanitized last error, descriptor hash, and schema version.
- Key sidecar entries by collection, physical generation, order-preserving encoded tuple, and
  document ID for keyset scans.
- Define tuple encoding that preserves current string/number ordering, direction, metadata fields,
  equality prefixes, ranges, document-ID tie breaks, cursors, and residual predicates.
- In the document transaction, add/set/update/delete and lazy-migration writes update both ready and
  building generations.
- Each backfill chunk migrates documents, validates index fields, upserts entries, and advances its
  cursor in one bounded transaction.
- Descriptor changes shadow-build a new generation and retain the previous ready generation until
  atomic promotion succeeds.
- A build failure records safe diagnostics without blocking unindexed CRUD and can be retried
  explicitly or on later activation.
- Add a storage layout migration from expression indexes and remove obsolete physical indexes only
  after a safe cutover.

# Scope

In scope:

- sidecar physical index layout and order-preserving tuple encoding;
- persisted resumable generations and bounded progress;
- consistency with writes during build;
- indexed-query readiness gates;
- layout migration, alarm integration, telemetry, and failure-injection tests.

Out of scope:

- automatic index selection, unindexed ordering, projection, or full-text search;
- a global index worker shared by partitions;
- migration strategy for collections without indexes;
- a public escape hatch for application-managed SQL indexes.

# Acceptance criteria

- Adding an index to a 100,000-document-equivalent fixture does not scan the full collection during
  activation, and normal get/add/update operations remain available.
- Queries selecting the building index return `INDEX_BUILDING` 503, never an empty partial result or
  silent scan fallback.
- Bounded work resumes from a persisted cursor across alarms, activation, and isolate recreation and
  reaches ready without duplicates or omissions.
- Documents added, updated, deleted, or lazily migrated during build appear correctly in the ready
  generation.
- A descriptor/schema change retains the previous ready generation until the replacement is ready.
- Equality, range, order, direction, and cursor results after promotion match the existing contract.
- Migration/index validation failures are observable without stopping unindexed CRUD.
- Layout migration never exposes an incomplete generation as ready.
- Workers failure injection covers interrupted alarms, isolate recreation, concurrent writes, and
  failure immediately before promotion.
- `vp check`, storage Workers tests, worker-runtime Workers tests, and the repository-wide gate pass.
