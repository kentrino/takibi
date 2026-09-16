---
title: Keep partitions available while typed indexes are rebuilt
author: OpenAI Codex
cost: 8
priority: P2
priority_reason: "Large partitions can enter long cold-start stalls or repeated activation failure, but the redesign is substantial and should follow core correctness fixes."
category: scalability
source_issue: 0058-online-index-backfill
---

# Keep partitions available while typed indexes are rebuilt

Typed index reconciliation currently migrates all documents and creates SQLite expression indexes during Durable Object activation; interruptions can repeat this work and delay every request. Make rebuild progress bounded and resumable while unindexed CRUD remains available, and never expose incomplete indexed results. Preserve typed index ordering, concurrent-write correctness, and restore/reset guarantees; validate availability and recovery with a 100,000-document-equivalent fixture before declaring success.

[Design](./design-a.md)

## Related Files

- `packages/storage/src/index-reconcile.ts` — blocking backfill and ready-only catalog
- `packages/storage/src/index-sql.ts` — physical expression-index representation
- `packages/storage/src/storage.ts` — indexed scans and writes
- `packages/worker-runtime/src/durable-object.ts` — activation barrier
- `packages/worker-runtime/src/migrations.ts` — lazy migration and restore preparation
