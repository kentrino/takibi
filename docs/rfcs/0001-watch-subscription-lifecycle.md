---
id: "0001"
title: Watch subscription lifecycle
status: accepted
implementation: complete
decided: 2026-09-17
created: 2026-09-16
implementation_issues:
  - ../issues/closed/0007-realtime-query-watch/issue.md
---

# Watch subscription lifecycle

## Context

A query watch produces snapshots over time, may reconnect after a temporary failure, and eventually
terminates. A positional `onPage` / `onError` API with a bare unsubscribe function cannot clearly
separate a retryable disconnect from a terminal server or protocol failure, or expose normal
completion. This contract is independent of the WebSocket wire format, full-snapshot behavior, and
authorization design in the implementation issue. It preserves [RFC 0008's](./0008-server-throws-client-results.md)
distinction between server-decided failures and transport or protocol failures.

## Decision

Use an observer with required `next` and optional `state`, and return a subscription handle
synchronously. The handle provides idempotent `unsubscribe()` and an always-fulfilling `closed`
promise. Callbacks begin asynchronously, so callers can always retain the handle before receiving a
snapshot. Invalid options may throw synchronously before a handle exists.

The user-approved entry-point clarification (2026-09-17) exposes this contract
through `createWatchClient` from `takibi/watch`. It composes HTTP methods and
collection `watch` explicitly; the ordinary `takibi/client` import graph excludes
the WebSocket runtime. Use native browser WebSocket and Durable Object Hibernation
APIs, with no new package, global registration, or transport library.

```ts
import { createWatchClient } from "takibi/watch";
const client = createWatchClient<typeof handler>(baseUrl);
const subscription = client.posts.watch(query, {
  next: (page) => setPosts(page.items),
  state: (state) => setConnectionState(state),
});

subscription.unsubscribe();
const outcome = await subscription.closed; // { reason: "unsubscribed" }
```

`state` reports non-terminal progress such as `connecting`, `open`, and `reconnecting`. Retryable
network or maintenance failures emit `reconnecting` and leave `closed` pending; retry until
unsubscribe or a terminal outcome. `closed` uses the
exact reasons `unsubscribed`, `server-error`, `protocol-error`, and `server-closed`. Terminal server
failures retain their typed failure value under `server-error`; invalid or obsolete protocol data
uses `protocol-error`; a normal server close uses `server-closed`. Each terminal path fulfills
`closed` exactly once and does not reconnect. The promise never rejects, so ignoring it cannot
create an unhandled rejection.

Unsubscribe synchronously suppresses later callbacks and retries; repeated calls are harmless.
Observer exceptions are application errors, not transport failures: report them through the host's
existing error-reporting mechanism without settling this or another subscription. An opaque browser
handshake failure remains retryable under the same reconnect rule because the browser may hide the
response details; it must not be invented into a typed authorization failure.

## Rationale and alternatives

The observer keeps the common UI path direct while the handle gives cleanup and final outcome
distinct homes. A bare unsubscribe callback API is smaller but leaves completion ambiguous. A
single discriminated event callback makes every snapshot consumer dispatch a union. Async iteration
adds queueing, backpressure, cancellation, and connection-start semantics without demonstrated need.
An options object alone does not resolve failure classification. Applications can continue polling
with `list` when a streaming lifecycle is unnecessary.

## Implementation choices

- `WatchState`, `WatchClosed`, `WatchSubscription`, and `WatchObserver` name the public contract.
- Observer errors use `globalThis.reportError`, with an asynchronous throw when the host lacks it.
- Existing list policy checks context expiry before each snapshot. An idle socket is not scheduled
  to close at its expiry deadline; denial terminates before delivery on re-evaluation.

## Verification

Contract tests should cover asynchronous first delivery, retryable reconnect, every terminal reason,
normal close, repeated unsubscribe, callback exceptions, opaque handshakes, and exactly-once
fulfillment. Ignoring `closed` must produce no unhandled rejection. Transport, authorization, and
whole-watch verification remain in the linked implementation issue.
