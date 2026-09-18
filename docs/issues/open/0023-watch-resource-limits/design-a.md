# Design A: Runtime-owned watch budgets

## Example

Proposed API; not implemented. Use the existing collection options, which already
reach the generated Durable Object, rather than putting transport limits into
authentication context or requiring applications to subclass the runtime.

```ts
// Before: no watch resource budget can be configured.
const app = builder.defineCollections(collections);

// After: omission uses finite library defaults; deployments can tune both limits.
const app = builder.defineCollections(collections, {
  watch: {
    maxConnections: 128,
    maxSnapshotBytes: 262_144,
  },
});
```

With these settings, the 129th concurrent admission is rejected before running
its list query. An initial snapshot larger than 262,144 UTF-8 bytes rejects the
upgrade. A later oversized snapshot terminates that watch without sending its
items; healthy watches and the mutation that triggered delivery continue normally.
The limit includes the complete JSON snapshot envelope, not just document bodies.

## Why this is the library's responsibility

`WatchRuntime.upgrade` queries, accepts a native socket, and sends a snapshot.
`#flush` re-runs list independently for every matching open socket on each dirty
collection. There is no admission budget or snapshot byte budget in either path.
The generated object owns these sockets privately; HTTP middleware cannot count
its live Hibernation sockets or intercept subsequent sends.

The current 16,384-byte attachment bound protects persisted query/context, and
the list row bound limits result cardinality. Neither limits concurrent watches
or serialized result bytes. This is an availability hardening requirement, not
a demonstrated authentication bypass or a measured production outage.

Commit `550b68332be89b2ad781330b8e5549754fa04bcb` introduced this behavior.
[Issue 0007](../../closed/0007-realtime-query-watch/issue.md) and its
[design](../../closed/0007-realtime-query-watch/design-a.md) deliberately document
full-snapshot fan-out and use native sockets as the registry. Keep that design;
add local resource admission and delivery checks, without a new package, SQLite
subscription registry, cache, or new transport.

Cloudflare's [state API](https://developers.cloudflare.com/durable-objects/api/state/)
documents a platform connection ceiling and warns that practical capacity depends
on CPU and memory. Its socket inventory can include closing connections. Its
[platform limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
describe a received-message limit, which is not an outgoing snapshot budget.
Sources checked on 2026-09-19; platform ceilings are not application capacity guarantees.

## Admission and lifecycle

Add `watch` options to `CollectionsOptions`, validate once, and pass normalized
values through `createDurableObjectClass` to `WatchRuntime`. Proposed defaults are
128 connections per object and 256 KiB per snapshot. These are conservative
starting values, not benchmark results; validate them with native runtime tests
and a representative chat workload before choosing the shipped defaults.
Require positive finite safe integers. Invalid settings fail configuration;
omission must not mean unlimited. Keep this configuration server-owned and out
of headers, query options, and persisted client attachments.

Before the first asynchronous operation in admission, synchronously reserve a
slot against the native inventory plus pending admissions. Keep the check and
reservation indivisible within the object. A pending counter is temporary state,
not a second socket registry. Release it in `finally` on every failure and after
acceptance; transfer reservation ownership to the accepted socket with no await
between acceptance and reservation release. A capacity rejection must not query
or accept a socket. The public handshake still performs authentication normally.

Count native retained sockets conservatively, including CLOSING entries, so a
client that does not complete closing cannot create arbitrarily many replacement
connections. Rebuild occupancy from `getWebSockets()` after Hibernation. Do not
blindly decrement a separate active count when `close()` is called. Verify when
the supported runtime actually removes sockets from this inventory; a stalled
close may reduce availability, but must not bypass the cap.

On recovery after reducing the cap, close excess open watches before scheduling
refresh queries; retain at most the configured number for further delivery. A
stable choice within that recovery is enough; do not add persisted ordering just
to select survivors. Retained closing sockets continue to block new admissions
until the runtime removes them. Recovery does not reset the effective budget.

## Snapshot delivery and failure behavior

Use one serialization/byte-check path for initial, commit-triggered, and recovered
snapshots. Keep policy evaluation and policy-owned list ranges unchanged. Measure
actual UTF-8 bytes, and reject before `send` if the complete envelope exceeds the
limit. Do not truncate results or silently reduce query limits: either would
misrepresent the requested list. Do not build a queue of rejected snapshots.

Use an existing `TakibiError` envelope shape with a stable proposed error code
`WATCH_SNAPSHOT_TOO_LARGE` (HTTP 413 before upgrade). On an established socket,
send a small constant-message terminal `server-error` envelope and close with the
existing `WATCH_ERROR_CLOSE`. Error contents must not include the rejected data,
query, or context. The snapshot budget applies to snapshots; this fixed terminal
envelope is separate. If even the error send fails, still close the socket.

For admission capacity use proposed `WATCH_CAPACITY_EXCEEDED` (HTTP 503).
Do not accept a socket merely to communicate a typed overload reason. Native
browsers hide handshake status, so the SDK keeps its existing jittered retry
behavior; do not claim it exposes the HTTP code to observers. Recovery eviction
can use the existing terminal server-error envelope with the capacity code.
No new frame kind or attachment version is needed.

A byte check after JSON serialization bounds delivery, not the memory needed to
read or serialize a single large document. Likewise a connection cap does not
bound query complexity, mutation frequency, or runtime-owned send buffers. State
these limits explicitly. Before calling this general memory/backpressure
protection, separately reproduce slow-consumer behavior in the supported Workers
runtime; a browser-style `bufferedAmount` contract must not be assumed. No ACK
protocol or arbitrary send throttling is justified by the current investigation.

## Alternatives and scope decisions

- Edge-only rate limiting cannot enforce live occupancy and post-upgrade snapshot
  delivery inside the generated object. Keep it as complementary deployment
  protection, not the implementation of this contract.
- Fixed constants would be smaller but force legitimate large workloads to fork
  the library. Two validated settings in existing options keep the boundary small.
- Shared query caching changes performance rather than placing a resource bound,
  and adds invalidation/authorization complexity. It is unnecessary here.
- Per-user limits, IP rate limits, cross-object quotas and anti-spam policies need
  application identity/routing choices. They are outside this minimum issue.

The earlier security discussion also considered built-in credential expiry and
immediate revocation APIs. Do not classify them as unconditional library MUSTs
under the current contract: [RFC 0001](../../../rfcs/0001-watch-subscription-lifecycle.md)
and issue 0007 explicitly keep expiry in list policy and exclude an idle expiry
timer; `watch.workers.ts` contains a test for denial before the next delivery.
A reusable expiry helper is useful ergonomics, while immediate external revocation
would require a new authentication lifecycle requirement and separate design.
This does not claim that the current API satisfies applications requiring
immediate logout or role-revocation enforcement. No such enhancement is filed here.

[Issue 0022](../0022-watch-pause-resume/issue.md) addresses client suspension and
lifecycle presentation. It does not enforce server capacity, so it is not a
duplicate and remains unchanged. Origin checks, per-snapshot authorization,
credential verification in `resolve`, and private internal DO ingress retain their
existing responsibilities.

## Compatibility and verification

The public settings are additive, but finite defaults can reject formerly accepted
workloads. Document this behavioral change and migration: choose explicit measured
limits or reduce watch window/document sizes. Existing attachment and envelope
formats remain compatible; new error codes use the existing extensible failure
format. HTTP list behavior and authorization are unchanged.

Required implementation tests:

- Concurrent delayed upgrades at the capacity boundary, including initial query,
  serialization and acceptance failures; assert excess attempts never query.
- Close/error cleanup, stalled closing peers, and capacity reuse after actual
  socket removal; run inventory assumptions in native Workers, not mocks alone.
- Recovery at capacity and with a lowered limit, including maintenance transitions;
  no excess watch is refreshed after eviction, and occupancy cannot be reset.
- Exact byte boundary and one byte over, including multibyte text, for initial,
  committed-update and recovered snapshots; no oversized frame is emitted.
- An oversized watch terminates while another watch still receives updates and
  the triggering write remains committed; policy denial still emits no documents.
- Invalid configuration and documented defaults; existing client terminal errors
  stop retries, while opaque failed handshakes retain jittered retries.

Investigation performed: read runtime, configuration, protocol, existing tests,
original implementation history and lifecycle decisions. No implementation, load
test, slow-consumer reproduction or test execution was performed for this issue.
Native close-inventory behavior and default capacity tuning remain implementation
verification tasks; neither is claimed as established by the source review.
