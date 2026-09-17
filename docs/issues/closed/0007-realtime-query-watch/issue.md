---
title: Watch typed queries with Durable Object WebSocket Hibernation
author: OpenAI Codex
cost: 8
priority: P3
priority_reason: "This is a large new capability and should follow transaction isolation, policy-owned list ranges, and partition-routing cleanup."
category: realtime
status: closed
closed_reason: implemented
source_issue: 0040-realtime-query-watch
---

# Resolution

Implemented `createWatchClient` at the opt-in `takibi/watch` entry, with the
accepted collection observer/handle API, typed indexed queries, full snapshots,
reconnect, and terminal outcomes. The ordinary client import graph excludes
WebSocket runtime. Native Durable Object Hibernation stores only versioned
query/context attachments; list policy, existing application stub routing,
commit observation, and maintenance gating remain in their existing packages.

Expiry follows the human decision: list policy checks before the next snapshot;
no idle deadline hook or scheduling is added. Issue 0016's merged application-owned
stub routing is reused. No external WebSocket library or new package was added.

Validation passed: `vp check`, `vp run -r test`, `vp run -r test:workers`, and
`vp run -r build`. The build also checks the emitted HTTP/watch import graphs.
The recursive gate retains six existing skipped Better Auth adapter tests.
Direct root `vp test` has an existing projects-glob startup error involving
`packages/tsconfig.takibi-pack.json`; the required recursive test gate passes.

Requirement coverage:

- Client lifecycle tests: asynchronous delivery, all terminal outcomes, opaque
  retries, fresh protocols, late-event suppression, idempotent unsubscribe,
  observer exceptions, unchanged reconnect snapshots, and native token constraints.
- Type tests: schema fields/operators, index-dependent ordering, unsupported cursors,
  cursor-free snapshots, typed policy reasons, and reserved action name `watch`.
- Protocol tests: shared list-wire normalization, invalid options, exact envelope
  fields, binary/malformed/obsolete frames, and attachment validation.
- Storage tests: nested commit coalescing, rollback/unknown outcomes, observer
  isolation, and exclusion of internal lazy-migration writes.
- SQLite-backed Workers tests: ascending/descending limited windows and ordering
  updates against list, policy ranges, collection/partition isolation, CRUD,
  actions and trusted transactions, recovered attachments, refreshed handshake
  context, expired authorization, origin/subprotocol/overflow rejection, restore,
  reset, and upgrade rejection during export. Synthetic fan-out covers 16 watches.
- Runtime tests: send failures, obsolete attachments, export suspension/resumption,
  maintenance races, and release after another read has noticed lease expiry.

Commit-observer, caught nested-transaction, and export-expiry regressions were observed failing before their
implementations/fixes. Other contract tests were added alongside implementation.
Reactivation is exercised by rebuilding a generated instance around native
Hibernation sockets; no production deployment or application-scale load test
was performed. Fan-out remains active watches multiplied by query cost.

RFC 0001 is marked implemented and records the entry-point and expiry clarifications.
Both design records are retained; references from issue 0018 are updated to this
closed location. The README includes authentication/lifetime limits and the
migration from an existing action named `watch`.

# Subscribe to changes in policy-bound list results

Chat and dashboard applications currently implement typed-list refresh and subscription cleanup themselves. Provide full-snapshot subscriptions that preserve existing list authorization, query constraints, and partition isolation. Completion requires safe handling of changes after commit, rollback, reconnection, Hibernation, expired authorization, and maintenance operations. Exclude cursors, delta delivery, and immediate external authentication revocation; document transport and context lifetimes and fan-out cost.

[Design](./design-a.md)

[Subscription lifecycle RFC](../../../rfcs/0001-watch-subscription-lifecycle.md)

## Accepted API (2026-09-17)

Implement opt-in `createWatchClient` from `takibi/watch`, exposing
`client.posts.watch(options, { next, state? })` with a synchronously returned
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

## Implementation clarifications (2026-09-17)

Use native browser WebSocket and Durable Object Hibernation without an external
transport library. Compose HTTP and watch through the separate factory; keep
WebSocket runtime out of `takibi/client` and introduce no new package. Check
authorization expiry with existing list policy before the next snapshot; no
idle expiry deadline hook or timer is required.
