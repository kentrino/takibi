# Design A: Subscribe to list snapshots after commit (selected)

## Decision and evidence

Selected for implementation on 2026-09-17 with the accepted RFC 0001 lifecycle and list-compatible `index` / `orderBy` support. At selection, `packages/client/src/client.ts` provided request/response CRUD, `watch` was not reserved, and subscriptions were unavailable. The implemented opt-in entry and reserved name now satisfy that gap. Policy-owned ranges were implemented in `98c759d` and `64af4cd`; that dependency needs no reimplementation. A design from first principles would handle an authorized query, commit notification, and connection lifetime together. A mutation-success callback alone cannot handle transaction rollback and trusted writes. Issue 0017 observes public invocations; do not repurpose or merge it into an invalidation bus.

History confirms coordination within each DO and the existing policy implementation, but acceptable application update latency and concurrent subscription counts remain unverified. Treat the use cases in the existing issue as requirement hypotheses, not measured load. Synthetic Workers verification covers 16 concurrent watches; target-application latency and load remain unmeasured. Fan-out remains concurrent watches multiplied by query cost.

## Boundaries and comparison

[A](./design-a.md) connects transport and commits within the existing client/protocol/runtime/storage responsibilities. Polling in [B](./design-b.md) is small and independently testable, and may suffice when delayed updates are acceptable, but does not meet post-mutation and Hibernation requirements. Do not create a separate realtime package here. Keep policy orchestration in worker-runtime without reversing the dependency toward storage; expose only the minimum necessary commit notification from storage. The justification for additional internal interfaces beyond public watch is limited to verifying transactions and trusted facades with the same tests.

## Corrections to the original proposal

- **Use commit as the boundary.** The observing decorator must also wrap scoped storage passed to transaction callbacks and retain the set of changed collections per outermost transaction. Publish only after successful commit and discard on rollback. Include trusted `$collections` transactions under the same rule. Do not classify an unknown commit outcome as success. Observe outside migration storage to exclude internal lazy-migration writes. Reject publishing on put completion or public invocation completion alone.
- Do not emit snapshots while the maintenance lease blocks normal reads/writes. At the start of restore/reset, disconnect watches for that DO with a retryable maintenance close and reject reconnection handshakes until maintenance ends. Obtain a new full snapshot after cutover. Export also suspends queries during maintenance and re-evaluates pending invalidations when the lease is released. Do not extend this into a general guarantee of tracking direct SQL writes.
- The Hibernation attachment `context` is a JSON snapshot from the handshake. Re-evaluating policy does not automatically refresh identity-provider revocation or role changes. Applications resolve identity/expiry without credentials and enforce required authorization freshness through trusted local decision inputs passed to policy and expiry checks. As required by 0005, policy performs no external I/O; reflecting changes in external authentication requires resolving again through a new handshake. Expiry is checked by existing list policy before the next snapshot and causes a terminal close then; idle sockets have no deadline timer. A new watch starts with fresh authentication. Takibi cannot identify raw credentials in arbitrary context, so it cannot guarantee that credentials are automatically excluded from storage. Copying HTTP headers themselves is prohibited.
- The GET upgrade query reuses the existing list wire representation and validates version and where/limit/index/orderBy. Do not put authentication values in URLs. Workers integration tests must verify browser subprotocol constraints, server protocol-selection responses, and cookie origin checks. When finalizing the wire format during implementation, use the same fixture to round-trip through the existing list parser.
- Validate versions of the socket registry and attachments; close obsolete versions terminally instead of creating an automatic reconnection loop. Test upgrades/deployments with active connections separately from restore/reset.

[Cloudflare WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) (checked on 2026-09-16) documents constructor re-execution after Hibernation, loss of in-memory state, and attachment recovery. Recheck current platform limits in the official limits documentation during implementation.

## Approved entry point (2026-09-17)

`createWatchClient` from `takibi/watch` composes HTTP methods with collection
watch methods. Native WebSocket runtime stays outside the ordinary `takibi/client`
import graph. The existing private client package owns the implementation; no
new package, external WebSocket library, global registration, or monkey-patching
is introduced. The observer/handle and indexed list semantics remain unchanged.

## Example

```ts
import { createWatchClient } from "takibi/watch";
const client = createWatchClient<typeof handler>(baseUrl);
// Before: The application owns repeated fetching and shutdown
const page = await client.posts.list({ where: (q) => q.roomId.eq(roomId), limit: 50 });
// After: New API; callbacks receive full snapshots without cursors
const subscription = client.posts.watch(
  { where: (q) => q.roomId.eq(roomId), limit: 50 },
  {
    next: (page) => setPosts(page.items),
    state: (state) => setConnectionState(state),
  },
);
subscription.unsubscribe();
const closed = await subscription.closed; // { reason: "unsubscribed" }
```

Initial and post-commit snapshots contain items within the same authorized range as list. Rollback emits no notification, and unsubscribe prevents callbacks and reconnects. Existing list behavior remains unchanged. However, reserving the action name `watch` changes compatibility; include a README migration example that renames any existing action with that name. External usage is unknown, so do not assume nobody uses it.

## Subscription lifetime and alternatives

The accepted [watch subscription lifecycle RFC](../../../rfcs/0001-watch-subscription-lifecycle.md)
extracts the client-side contract from this whole-watch design. It specifies an observer with
`next` and optional `state`, plus synchronous, idempotent unsubscribe and an always-fulfilling
`closed` promise. It keeps retryable reconnect state distinct from terminal server, protocol, and
normal-close outcomes, defines opaque browser handshake and cleanup behavior, and uses the host
`reportError` hook with an asynchronous throw fallback for callback exceptions. The opt-in `takibi/watch` entry provides the implemented watch API.

## Verification status and remaining checks

Implementation and verification are recorded in [the closed issue](./issue.md).
The recursive tests, Workers gate, build, and format/lint/type checks pass.
Coverage includes rollback, trusted transactions, restore/reset/export, expired
context before delivery, native subprotocols, indexed list parity, reactivation,
and the reserved action name. The build checks HTTP-only import independence.
Current Cloudflare documentation was rechecked: attachments support 16,384 bytes
and Hibernation supports up to 32,768 connections per object, subject to workload.
Tests exercise 16 watches; this is not an application capacity guarantee or a
production deployment test.

## Retained detailed specification and acceptance criteria

## Problem

The public Takibi client executes collection CRUD and actions as request/response calls. Typed
`list` queries support filters, ordering, cursors, per-partition Durable Objects, and collection
policy, but an open client is not notified when stored results change. Chat, collaboration, and
operational dashboards must implement polling, refresh triggers, and subscription cleanup outside
Takibi.

A Durable Object already coordinates reads and writes for one application-selected partition, so it
can also coordinate change notification. Cloudflare's WebSocket Hibernation API keeps connections
open while an idle object leaves memory, but using it safely requires more than broadcasting after a
mutation:

- browser WebSockets cannot reuse arbitrary HTTP headers from `CreateClientOptions.headers`;
- query and authorization state must survive hibernation without persisting raw credentials;
- every snapshot must preserve normal list policy, the policy-owned list range, and partition isolation;
- writes from CRUD, actions, and trusted collection facades need one invalidation path.

## Proposal

Add `watch` to the opt-in collection client created by `createWatchClient` from `takibi/watch`. It subscribes to the full result of a typed list query:

```ts
const subscription = client.posts.watch(
  { where: (q) => q.roomId.eq(roomId), limit: 50 },
  { next: (page) => setPosts(page.items) },
);
const closed = await subscription.closed;
if (closed.reason === "server-error") reportError(closed.error);
```

`watch` returns a subscription handle synchronously. After connecting, it emits the current
`{ items }` snapshot once. Each successful mutation of the watched collection re-runs the effective
query and emits a new full snapshot. The client suppresses a callback when the serialized snapshot
is unchanged.

The initial surface accepts `where`, `limit`, `index`, and `orderBy`. It uses the same field types,
query operators, normalization, default limit, maximum limit, and index-dependent option typing as
`list`. `orderBy` requires a declared index and selects a field of that index; preceding index
fields require single-value equality constraints, exactly as in list execution. Without an index,
results are id-ascending. Selected-index order, direction, suffix ordering, and id tie-breaking
follow [RFC 0012](../../../rfcs/0012-typed-index-ordering.md); do not add an in-memory sort fallback. It rejects `cursor`
in both types and runtime validation because a fixed cursor has ambiguous meaning over a changing
result set. It does not include `nextCursor`.

For a collection declaring `byRoomCreatedAt: ["roomId", "createdAt"]`, watch the latest 50 posts:

```ts
const subscription = client.posts.watch(
  {
    index: "byRoomCreatedAt",
    where: (q) => q.roomId.eq(roomId),
    orderBy: (q) => q.createdAt.desc(),
    limit: 50,
  },
  { next: ({ items }) => setPosts(items) },
);
```

Re-run the complete ordered, limited query after commit so inserts, deletes, and ordering-field
updates correctly replace or reorder items in the watched window. Preserve normalized index and
order options through the upgrade request, Hibernation attachment, and reconnect.

Reserve `watch` as a collection method in `@takibi/api` and action registration. Do not introduce a
new permission: connection and every re-evaluation require the existing `list` permission and apply
the same policy-owned list range as normal policy-bound list execution. Reuse the evaluate-and-compose
path from
[0018-policy-owned-list-range](../../closed/0018-policy-owned-list-range/issue.md);
do not invent a second scope mechanism.

## Transport and authorization

Use `GET` plus `Upgrade: websocket` on the public collection route. A non-upgrade `GET` remains the
normal list route. The Worker performs the normal application `resolve` and `stub` routing for every
handshake, then sends only JSON-safe resolved context, collection name, and normalized watch options
to the selected Durable Object. Takibi must not infer a partition from `context.tenantId` or compare
application context fields with the Durable Object name.

Browser authentication uses cookies or a new `CreateWatchClientOptions.webSocketProtocols` callback.
The callback is evaluated on every connection attempt so applications can refresh short-lived
credentials. Takibi does not interpret the credential format. Values from `headers` are never
copied into the URL, WebSocket protocols, or connection attachment.

The Durable Object accepts the socket only after list authorization and effective-query compilation
succeed. It stores a versioned `{ collection, list, context }` attachment with
`serializeAttachment`. Validate attachment size against the current Cloudflare limit before
acceptance and fail closed when an attachment cannot be serialized. On reactivation, rebuild the
subscription solely from `state.getWebSockets()` and validated attachments; do not persist a second
subscription registry in SQLite.

Re-evaluate policy and the policy-owned list range for every snapshot. A policy denial, invalid
attachment, or protocol violation sends a terminal error envelope and closes the socket without
revealing documents.

## Reconnection and failure behavior

- reconnect abnormal closures using jittered exponential backoff from 250 ms up to 30 seconds;
- call `webSocketProtocols` and application `resolve` again on each reconnect;
- do not reconnect after unsubscribe, a normal close, or a terminal protocol/policy error;
- expose retryable failures through the optional state observer and terminal outcomes through
  the always-fulfilling `closed` promise defined above;
- isolate serialization and `send` failures to the affected socket so they cannot fail the mutation
  response or other subscriptions.

## Package boundaries

- `@takibi/api` owns the typed `watch` surface and reserved-name constraint.
- `@takibi/client` owns browser connection lifecycle, snapshot deduplication, reconnect, and
  unsubscribe behavior.
- `@takibi/protocol` owns versioned watch request and server-to-client `snapshot`/`error` envelopes.
- `@takibi/worker-runtime` owns HTTP upgrade routing, resolved-context forwarding, policy execution,
  and generated Durable Object WebSocket handlers.
- `@takibi/storage` may provide a mutation-observing decorator, but query execution and WebSocket
  state must not leak into the storage package.

## Implementation notes

- Compile the typed `where` and `orderBy` callbacks once on the client using existing list
  compilation. Reuse index and ordering validation, and reject cursor options at the API boundaries.
- Add `webSocketMessage`, `webSocketClose`, and `webSocketError` to the generated Durable Object and
  use only the Hibernation API for accepted sockets.
- Treat binary messages, client application messages, malformed envelopes, and unknown protocol
  fields as protocol errors.
- Place mutation observation outside migration storage so public CRUD, collection/root actions,
  policy-bound collections, trusted `$collections`, and generated Durable Object facades share one
  invalidation path while internal lazy-migration writes do not look like user mutations.
- Coalesce invalidations for the same collection within one turn. Do not promise to hide
  intermediate snapshots from multiple writes outside one transaction.
- Document that initial fan-out cost is `active watches for the collection × query cost`; do not add
  dependency graphs, deltas, result caches, or server-side snapshot sharing in the first version.

## Scope

In scope:

- typed collection query watch, existing index/orderBy support, and unsubscribe;
- initial and post-mutation full snapshots;
- Durable Object WebSocket Hibernation and attachment recovery;
- handshake authentication, per-snapshot list authorization, and the policy-owned list range;
- reconnect, terminal errors, protocol types, Workers integration tests, and documentation.

Out of scope:

- watching one document, action results, or multi-collection queries;
- deltas, optimistic updates, offline state, local mutation queues, or dependency tracking;
- cursor pagination, projection, or a new ordering contract;
- direct application writes through `state.storage.sql`;
- a Node-only WebSocket transport, React hooks, or identity-provider revocation push.

## Acceptance criteria

- `client.posts.watch({ where }, { next })` infers fields and values from schema output and rejects an
  unknown field, invalid operator, or cursor at compile time.
- Indexed options infer declared index names and their orderable fields; reject unknown indexes,
  fields outside the selected index, and orderBy without index in types and runtime validation.
  Runtime validation preserves list's equality-prefix requirements.
- Initial and post-commit snapshots match list for indexed ascending and descending queries,
  equality prefixes, tied values, and limits. Inserts, deletes, and ordering-field updates refresh
  the correct limited window; unchanged snapshots do not notify. Hibernation and reconnect retain
  these options and ordering semantics.
- A collection action named `watch` is rejected in types and runtime registration.
- Connection emits one snapshot equal to normal list semantics for the same effective query.
- Add, set, update, and delete correctly handle a document entering, remaining in, or leaving the
  result; unrelated collections and partitions do not emit.
- CRUD, action, policy-bound, trusted, and generated Durable Object writes share the invalidation
  path, while lazy migration alone does not produce a user mutation event.
- Every handshake runs application `resolve` and `stub`; every snapshot enforces list policy and
  the policy-owned list range without relying on a `tenantId` context property.
- Hibernation/reactivation restores valid subscriptions from attachments and the next mutation emits
  the correct snapshot.
- Unsubscribe prevents callbacks and reconnects; abnormal close reconnects with refreshed protocols
  and resolved context.
- Retryable failures leave `closed` pending; terminal server/protocol errors and normal server
  closure fulfill the matching reason exactly once and never reconnect. Typed policy reasons
  remain available in the terminal server envelope.
- Repeated unsubscribe is harmless and synchronously suppresses callbacks/retries. Ignoring
  `closed` never creates an unhandled rejection; callback exceptions do not become transport
  failures or disrupt other subscriptions.
- Credentials from HTTP headers are never copied to the URL, protocol list, or attachment.
- Attachment overflow, malformed frames, and snapshot send failures are isolated and fail closed.
- Workers tests cover Upgrade, Hibernation, partition isolation, authorization, and CRUD/action
  fan-out using a SQLite-backed Durable Object.
- README documentation matches full-snapshot semantics, index/orderBy parity with list, unsupported cursors, authentication,
  context lifetime, reconnect, current platform limits, and fan-out cost.
- `vp check`, `vp run -r test:workers`, and the repository-wide test gate pass.

## References

- [0018-policy-owned-list-range](../../closed/0018-policy-owned-list-range/issue.md)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Convex realtime documentation](https://docs.convex.dev/realtime)
