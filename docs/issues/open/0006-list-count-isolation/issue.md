---
title: Measure list/count occupancy before changing consistency
author: OpenAI Codex
cost: 5
priority: P2
priority_reason: "The current behavior is correct, but long list and count transactions may delay unrelated work and need measurement before optimization."
category: performance
---

# Measure list/count occupancy before changing consistency

Policy-bound list/count hold one transaction through policy, scanning, and lazy migration persistence, so other root operations in the same Durable Object wait. The practical latency cost is unmeasured and the current isolation is valid. Measure list and count separately, specify page/count/multiple-call consistency for policy-bound and trusted access, and choose whether to retain or change the boundary with evidence. Preserve enclosing atomic transactions and document any changed rollback or isolation contract; retaining the implementation is an acceptable completed investigation.

[Design](./design-a.md)

## Related Files

- `docs/spec/collection-operation-isolation.md` — existing guarantees and evidence
- `packages/storage/src/storage.ts` — operation queue and chunked scans
- `packages/worker-runtime/src/executor.ts` — count traversal and trusted transactions
- `packages/worker-runtime/src/migrations.ts` — migration recheck and persistence
- `packages/takibi/tests/atomic-actions.workers.ts` — enclosing transaction verification
