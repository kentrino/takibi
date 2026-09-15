---
title: Avoid document materialization for migration-safe collection counts
author: OpenAI Codex
cost: 5
priority: P2
priority_reason: "Count currently materializes every matching document, but the problem is performance rather than incorrect results."
category: performance
source_issue: 0053-storage-native-count
---

# Avoid document materialization for migration-safe collection counts

Collection count currently traverses storage.list in pages of 200 and materializes matching documents. Add a storage-owned aggregate path where it preserves list-equivalent predicates, migration/version failures, and authorization, with a scan fallback when transformation is necessary. Prove that eligible indexed and unindexed counts use one aggregate without document pages, forward count through storage decorators, and remove runtime pagination-based countDocuments. The existing server-only API remains unchanged.

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/executor.ts` — current count pagination and policy/trusted dispatch
- `packages/worker-runtime/src/migrations.ts` — read transforms and version errors
- `packages/storage/src/types.ts` — storage operation contract
- `packages/storage/src/storage.ts` — SQLite filtering and index scans
- `packages/worker-runtime/src/tracing.ts` — operation instrumentation
