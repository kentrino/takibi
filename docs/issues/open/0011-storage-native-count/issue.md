---
title: Execute collection count as a storage-native aggregate
author: OpenAI Codex
cost: 5
priority: P2
priority_reason: "Count currently materializes every matching document, but the problem is performance rather than incorrect results."
category: performance
source_issue: 0053-storage-native-count
---

# Problem

Server-side `CollectionApi.count` and `TrustedCollectionApi.count` are public, but
`packages/worker-runtime/src/executor.ts` implements them by repeatedly calling `storage.list` with
pages of at most 200 documents and summing item counts. Responsibility moved into Takibi, while the
cost remains full document materialization and pagination.

`@takibi/storage` already compiles Takibi predicates and typed index ranges to SQLite, so a
collection without a migration transform can use one `COUNT(*)`. `StorageDriver` has no aggregate
operation, preventing the runtime from selecting that safe native path.

Existing list-equivalent semantics are more important than always using SQL aggregation. Rows from
an old schema version may need migration before filtering, and residual predicates must remain
identical to list.

# Proposal

Add an internal count operation to `StorageDriver`:

```ts
type StorageCountOptions = Pick<StorageListOptions, "where" | "index">;

type StorageDriver = {
  // Existing operations.
  count(resource: string, options?: StorageCountOptions, plan?: StorageListPlan): Promise<number>;
};
```

This does not add count to the public HTTP client. Server policy-bound count continues to require
the list permission; trusted count continues to bypass policy.

- SQLite storage uses one `COUNT(*)` for indexed and unindexed queries when no read transform is
  required.
- When a migration/read transform is required, the storage decorator may use a safe scan path in
  the first implementation, but its result and failures must equal a complete list traversal.
- Collections without migrations must not receive a redundant read plan that disables native count.
- Logging, tracing, initialization, maintenance, and other `StorageDriver` decorators forward count
  as one operation.

# Package boundaries

- `@takibi/storage` owns `StorageDriver.count`, SQL generation, index-range reuse, and storage-level
  tests.
- `@takibi/worker-runtime` owns migration-aware fallback, policy/trusted facade dispatch, and removal
  of pagination-based `countDocuments`.
- `@takibi/api` keeps the existing server collection types; `@takibi/client` and public wire
  protocol do not gain count.

# Implementation notes

- Share predicate binding and scalar/null/missing/string semantics with the existing SQL query
  compiler; do not create a second query dialect for count.
- Indexed count must use the same equality prefix, range, and residual predicate as indexed list.
- Add `count` transparently to traced/logged storage and the after-initialization and maintenance
  decorators.
- Verify the native path does not call list using a spy, trace, or SQL instrumentation.

# Acceptance criteria

- A collection without migrations completes count with one SQLite aggregate query and materializes
  no document pages.
- Count equals a full list traversal for indexed and unindexed queries, metadata fields, null,
  missing fields, `in`, string operators, and ranges.
- Indexed equality-prefix and range counts equal the corresponding indexed list result.
- Collections containing old-schema documents retain transform-after-migration semantics and surface
  the same migration failures as list.
- Policy-bound count still requires list permission and trusted count still bypasses policy.
- The public client and HTTP protocol do not expose count.
- Tracing records one storage count span instead of a sequence of list spans.
- `countDocuments` and its pagination dependency are removed from worker-runtime.
- `vp check`, storage Node/Workers tests, worker-runtime tests, and the repository-wide gate pass.
