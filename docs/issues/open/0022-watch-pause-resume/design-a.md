# Explicit suspension and complete watch state

## Proposed surface

Extend the existing subscription handle with `pause(): void` and `resume(): void`.
Keep `unsubscribe()` and the always-fulfilling, typed `closed` promise.
Extend the state callback with `paused` and `closed`:

| State | Meaning |
| --- | --- |
| `connecting` | Establishing a connection, including after resume |
| `open` | Connected; initial data arrives separately through `next` |
| `reconnecting` | Temporary failure; automatic retry is scheduled |
| `paused` | Intentionally suspended; no active socket or automatic retries |
| `closed` | Permanently finished; resume cannot restart this handle |

Prefer `closed` over `disconnected`, which can also describe a transient network
failure or an intentional pause. The completion reason remains in `closed` rather
than broadening the state callback into an error API.

```ts
const subscription = client.messages.watch(query, {
  next: ({ items }) => renderMessages(items),
  state: (state) => renderConnectionState(state),
});

// Called by application-owned inactivity or view-lifecycle logic:
subscription.pause();
subscription.resume();

// Permanent cleanup:
subscription.unsubscribe();
```

No built-in ten-minute timeout or blur listener. Applications choose the activity
signals and delay, combine multiple suspension reasons, remove their listeners on
cleanup, and retain responsibility for replacing subscriptions when queries or
rooms change. Suspension only affects this watch, not the client's HTTP methods.

## Lifecycle requirements

- Pause releases the socket, cancels retry timers, and invalidates pending
  credential results and late socket events. It does not fulfill `closed`.
- Repeated pause while paused and resume while active are no-ops. Calls on a
  permanently closed handle do not restart it. Unsubscribe while paused still
  completes permanently. Network errors caused by local pause must not retry.
- Resume keeps the query and observer, obtains fresh credentials, and runs the
  normal server handshake, including `resolve`, `stub`, and authorization.
  Receive the current full snapshot rather than replaying changes during pause.
  Deliver the first resumed snapshot even if it equals the pre-pause snapshot,
  so a UI waiting for refreshed data can leave its loading state. Preserve
  existing identical-snapshot suppression for ordinary network reconnects.
- Terminal failures and normal server completion notify `closed` state once,
  settle the completion promise once, and cancel all further work. A fresh watch
  is needed after permanent completion. Callback exceptions must retain the
  existing host-reporting behavior without preventing cleanup or settlement.
- Keep generation checks so stale asynchronous work cannot reopen a paused or
  closed subscription or publish data from a superseded connection.

## Resolve before implementation

RFC 0001 currently makes state non-terminal, starts callbacks asynchronously, and
requires unsubscribe to synchronously suppress later callbacks. Adding a terminal
notification on explicit unsubscribe needs an explicit amendment, not an accidental
exception. Specify whether it is emitted within unsubscribe before returning, and
how immediate unsubscribe before the first callback behaves. Document the chosen
ordering of state notification and promise settlement, including pause/resume or
unsubscribe invoked from inside observers. Do not silently emit callbacks after
unsubscribe returns or drop the promised terminal notification.

Adding union members affects exhaustive switches in consumers. Include a migration
note and update the example to use SDK lifecycle states directly, while retaining
view-generation protection where it is still necessary. Revise the README's
current recommendation to synthesize a terminal UI state from `closed.then`.

## Verification

Use deterministic WebSocket doubles and fake timers for connection, pending
credentials, backoff, immediate pause, repeated controls, rapid pause/resume,
late events, unchanged resumed snapshots, and observer reentrancy/errors. Verify
no socket or retry remains active while paused, fresh credential resolution on
resume, and no restart or callbacks after permanent cleanup under the selected
notification contract. Cover every terminal reason and exactly-once completion.
Type-check new states and controls without widening collection policy reason
codes. Use the existing Workers tests to verify fresh resolution/authorization
and current snapshot delivery after reconnection where coverage is missing.
