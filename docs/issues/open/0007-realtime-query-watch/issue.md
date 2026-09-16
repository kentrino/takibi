---
title: Watch typed queries with Durable Object WebSocket Hibernation
author: OpenAI Codex
cost: 8
priority: P3
priority_reason: "This is a large new capability and should follow transaction isolation, policy-owned list ranges, and partition-routing cleanup."
category: realtime
source_issue: 0040-realtime-query-watch
---

# Subscribe to changes in policy-bound list results

Chat and dashboard applications currently implement typed-list refresh and subscription cleanup themselves. Provide full-snapshot subscriptions that preserve existing list authorization, query constraints, and partition isolation. Completion requires safe handling of changes after commit, rollback, reconnection, Hibernation, expired authorization, and maintenance operations. Exclude cursors, delta delivery, and immediate external authentication revocation; document transport and context lifetimes and fan-out cost.

[Design](./design-a.md)

[Subscription lifecycle RFC](../../../rfcs/0001-watch-subscription-lifecycle.md)

## Accepted API (2026-09-17)

Implement `client.posts.watch(options, { next, state? })` with a synchronously returned
`{ unsubscribe, closed }` handle, as accepted in RFC 0001. Options support `where`,
`limit`, `index`, and index-bound `orderBy` with the same typing, validation, and
ordering semantics as `list`; exclude `cursor` and `nextCursor`. Deliver full
`{ items }` snapshots after commit, suppress unchanged snapshots, and preserve the
RFC's reconnect, terminal-outcome, and unsubscribe contract. Verify indexed ascending
and descending limited results against `list`, including changes to ordering fields.

Coordinate partition-routing behavior with issue 0016, which was dispatched separately;
reuse its changes when available rather than introducing another routing contract.

## Related Files

- `packages/client/src/client.ts`
- `packages/api/src/action.ts`
- `packages/worker-runtime/src/context/types.ts`
- `packages/storage/src/types.ts`
- `packages/snapshot/src/maintenance.ts`
