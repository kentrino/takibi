---
title: Watch typed queries with Durable Object WebSocket Hibernation
author: OpenAI Codex
cost: 8
priority: P3
priority_reason: "This is a large new capability and should follow transaction isolation, server-owned list scopes, and partition-routing cleanup."
category: realtime
source_issue: 0040-realtime-query-watch
---

# Problem

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
- every snapshot must preserve normal list policy, server-owned scope, and partition isolation;
- writes from CRUD, actions, and trusted collection facades need one invalidation path.

# Proposal

Add `watch` to the public collection client. It subscribes to the full result of a typed list query:

```ts
const unsubscribe = client.posts.watch(
  { where: (q) => q.roomId.eq(roomId), limit: 50 },
  (page) => setPosts(page.items),
  (error) => reportError(error),
);
```

`watch` returns an unsubscribe function synchronously. After connecting, it emits the current
`{ items }` snapshot once. Each successful mutation of the watched collection re-runs the effective
query and emits a new full snapshot. The client suppresses a callback when the serialized snapshot
is unchanged.

The initial surface accepts only `where` and `limit`. It uses the same field types, query operators,
normalization, default limit, maximum limit, and deterministic order as `list`. It rejects `cursor`
in both types and runtime validation because a fixed cursor has ambiguous meaning over a changing
result set. It does not include `nextCursor`.

Reserve `watch` as a collection method in `@takibi/api` and action registration. Do not introduce a
new permission: connection and every re-evaluation require the existing `list` permission and apply
the same server-owned effective scope as normal policy-bound list execution.

# Transport and authorization

Use `GET` plus `Upgrade: websocket` on the public collection route. A non-upgrade `GET` remains the
normal list route. The Worker performs the normal application `resolve` and `stub` routing for every
handshake, then sends only JSON-safe resolved context, collection name, and normalized watch options
to the selected Durable Object. Takibi must not infer a partition from `context.tenantId` or compare
application context fields with the Durable Object name.

Browser authentication uses cookies or a new `CreateClientOptions.webSocketProtocols` callback.
The callback is evaluated on every connection attempt so applications can refresh short-lived
credentials. Takibi does not interpret the credential format. Values from `headers` are never
copied into the URL, WebSocket protocols, or connection attachment.

The Durable Object accepts the socket only after list authorization and effective-scope compilation
succeed. It stores a versioned `{ collection, list, context }` attachment with
`serializeAttachment`. Validate attachment size against the current Cloudflare limit before
acceptance and fail closed when an attachment cannot be serialized. On reactivation, rebuild the
subscription solely from `state.getWebSockets()` and validated attachments; do not persist a second
subscription registry in SQLite.

Re-evaluate policy and server-owned list scope for every snapshot. A policy denial, invalid
attachment, or protocol violation sends a terminal error envelope and closes the socket without
revealing documents.

# Reconnection and failure behavior

- reconnect abnormal closures using jittered exponential backoff from 250 ms up to 30 seconds;
- call `webSocketProtocols` and application `resolve` again on each reconnect;
- do not reconnect after unsubscribe, a normal close, or a terminal protocol/policy error;
- report connection and server failures to the optional error callback without creating an
  unhandled rejection when it is omitted;
- isolate serialization and `send` failures to the affected socket so they cannot fail the mutation
  response or other subscriptions.

# Package boundaries

- `@takibi/api` owns the typed `watch` surface and reserved-name constraint.
- `@takibi/client` owns browser connection lifecycle, snapshot deduplication, reconnect, and
  unsubscribe behavior.
- `@takibi/protocol` owns versioned watch request and server-to-client `snapshot`/`error` envelopes.
- `@takibi/worker-runtime` owns HTTP upgrade routing, resolved-context forwarding, policy execution,
  and generated Durable Object WebSocket handlers.
- `@takibi/storage` may provide a mutation-observing decorator, but query execution and WebSocket
  state must not leak into the storage package.

# Implementation notes

- Compile the typed `where` callback once on the client and reject unknown fields, operators, and
  cursor options at the existing API boundaries.
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

# Scope

In scope:

- typed collection query watch and unsubscribe;
- initial and post-mutation full snapshots;
- Durable Object WebSocket Hibernation and attachment recovery;
- handshake authentication, per-snapshot list authorization, and mandatory list scope;
- reconnect, terminal errors, protocol types, Workers integration tests, and documentation.

Out of scope:

- watching one document, action results, or multi-collection queries;
- deltas, optimistic updates, offline state, local mutation queues, or dependency tracking;
- cursor pagination, projection, or a new ordering contract;
- direct application writes through `state.storage.sql`;
- a Node-only WebSocket transport, React hooks, or identity-provider revocation push.

# Acceptance criteria

- `client.posts.watch({ where }, onPage)` infers fields and values from schema output and rejects an
  unknown field, invalid operator, or cursor at compile time.
- A collection action named `watch` is rejected in types and runtime registration.
- Connection emits one snapshot equal to normal list semantics for the same effective query.
- Add, set, update, and delete correctly handle a document entering, remaining in, or leaving the
  result; unrelated collections and partitions do not emit.
- CRUD, action, policy-bound, trusted, and generated Durable Object writes share the invalidation
  path, while lazy migration alone does not produce a user mutation event.
- Every handshake runs application `resolve` and `stub`; every snapshot enforces list policy and
  server-owned scope without relying on a `tenantId` context property.
- Hibernation/reactivation restores valid subscriptions from attachments and the next mutation emits
  the correct snapshot.
- Unsubscribe prevents callbacks and reconnects; abnormal close reconnects with refreshed protocols
  and resolved context.
- Credentials from HTTP headers are never copied to the URL, protocol list, or attachment.
- Attachment overflow, malformed frames, and snapshot send failures are isolated and fail closed.
- Workers tests cover Upgrade, Hibernation, partition isolation, authorization, and CRUD/action
  fan-out using a SQLite-backed Durable Object.
- README documentation matches full-snapshot semantics, unsupported cursors, authentication,
  context lifetime, reconnect, current platform limits, and fan-out cost.
- `vp check`, `vp run -r test:workers`, and the repository-wide test gate pass.

# References

- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Convex realtime documentation](https://docs.convex.dev/realtime)
