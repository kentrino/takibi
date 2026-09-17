---
title: Add explicit watch pause/resume and complete lifecycle state notifications
author: OpenAI Codex
cost: 3
priority: P2
priority_reason: "Applications must currently recreate subscriptions to suspend traffic and combine state callbacks with closed promises just to display the full lifecycle."
category: realtime
---

# Add explicit watch pause/resume and complete lifecycle state notifications

Applications may want to suspend a watch after ten minutes without interaction,
when a view is hidden, or on blur. Today they must unsubscribe, retain the query
and observer, and create a new subscription to resume. Displaying terminal status
also requires combining `state` with `closed.then`.

Provide explicit pause/resume controls on the watch handle and lifecycle state
notifications that distinguish intentional suspension, retryable connection loss,
and permanent completion. Keep inactivity timers, focus/visibility listeners,
and the decision to suspend in the application; blur alone does not mean a view
is hidden or its data is no longer needed.

Completion requires a documented lifecycle contract and tests for pausing during
connection, credential resolution, live delivery, and retry backoff; repeated
pause/resume; rapid transitions; stale events; callback reentrancy; and terminal
outcomes while paused. Resume must establish a fresh authenticated handshake and
obtain the current full snapshot, without replaying missed changes. Pause leaves
`closed` pending; unsubscribe remains permanent and fulfills it exactly once.

Include terminal state notifications so ordinary connection UI does not need a
separate completion-promise listener. Retain `closed` for awaiting completion and
accessing typed reasons. Explicitly resolve notification timing and unsubscribe
compatibility with RFC 0001, including exhaustive `WatchState` consumers. Update
the public watch guide and realtime chat lifecycle handling. Do not add automatic
idle/blur policy, a new package, or a server-side inactivity/credential-expiry timer.

[Design and contract decisions](./design-a.md)

## Related work

- [Issue 0007: implemented query watch](../../closed/0007-realtime-query-watch/issue.md)
- [RFC 0001: current lifecycle contract](../../../rfcs/0001-watch-subscription-lifecycle.md)

This is a follow-up to the completed watch implementation, not a reopening of its
original scope. Amend or supersede the relevant RFC decisions when implementing.

## Related Files

- `packages/api/src/watch.ts`
- `packages/client/src/watch-subscription.ts`
- `packages/client/src/watch.ts`
- `packages/client/tests/watch.test.ts`
- `packages/client/tests/watch-types.test.ts`
- `packages/takibi/README.md`
- `examples/realtime-chat/src/client/main.ts`
- `examples/realtime-chat/src/shared.ts`
