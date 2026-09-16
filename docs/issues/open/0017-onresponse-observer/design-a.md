# Design A: Connect a safe public observer to existing notification (recommended)

## Decision and cause

Reassessed on 2026-09-16: keep open. `ContextConfig` contains only resolve/stub/services/logging, and invocationNotify in `adapter-map.ts` is undefined. `invocation-lifecycle/src/flow.ts` already performs settlement → snapshot → awaited notify and stores exceptions in notification.failed. `invocation-adapters.ts` applies structuredClone and then freezes the outer object. No new lifecycle is needed.

Commit `1b1de81` extracts the generic invocation lifecycle and supports keeping Takibi-specific policy/projection in the runtime. The original source for the no-lifecycle-hooks decision mentioned by the issue has not been located. Do not invent its existence or rationale; document the currently established distinction between read-only observation and transaction hooks in the new RFC.

## First principles, alternatives, and boundaries

A natural design sends only safe values from completed public invocations to one place. A keeps that narrow projection in worker-runtime. The HTTP wrapper in [B](./design-b.md) is easy to introduce but does not own settlement across all paths or batch-item granularity. Transactions/outboxes address the separate need for durable delivery and do not count as successful substitutes for this observer. Doing nothing leaves dispatch duplication in each application.

Keep the generic lifecycle unaware of Takibi event types, services, and log names. Create no new package: the runtime owns projection, configuration, and service binding, and the facade re-exports types. Initially place the public event type in runtime; do not move it to api/shared-types without evidence that sharing is necessary. Verify independently with the same fixtures for existing single/batch runners and the testing backend.

## Corrections and compatibility

- A `readonly` type alone cannot prevent mutations of nested `data`/`ctx`. Preserve structuredClone to detach the observer view from the original result/context, and make the public event type readonly. Be explicit that Object.freeze is shallow; do not introduce a new guarantee of deep freezing. Services are actual closure-bound objects, are not cloned, and cannot be promised free of external side effects.
- `invocation-response.ts` currently logs only settlement failures; it does not log notification.failed. Add wiring at the common runtime response-conversion boundary to log each notification failure once as `takibi.onResponse`. Test that single and batch conversions do not duplicate logs rather than scattering try/catch around observer calls. Preserve the existing rule that logger failures do not change the original response.
- Reuse wire-response normalization for failure results and select only code/status. Do not project internal error messages, inputs, issues, or reasons. Context itself contains application-selected information and must be distinguished from the privacy guarantees of the projection.
- The observer runs after transaction settlement and before the response. Settled failures include unknown transaction outcomes; observation does not guarantee confirmed rollback. Awaiting adds response latency. Isolate termination or connection loss can lose delivery, and a client retry creates a new invocation that may notify again. Once means at-most-once within one invocation runner, not durable exactly-once delivery.
- The new setting is optional, so unconfigured applications retain current behavior. Pass the same configuration through both CreateContextFn overloads, the generated DO, and the SQLite testing path. Do not count trusted internal collection calls as separate public invocations. Do not merge this with commit invalidation in 0007.

## Example

```ts
// Before: Every action repeats await services.events.send(...)
// After: Keep the existing resolve/stub/services configuration
const t = createTakibi()({
  resolve,
  stub,
  services,
  onResponse: async ({ invocation, result, ctx, services }) => {
    if (result.ok)
      await services.events.send({ invocation, data: result.data, userId: ctx.userId });
  },
});
```

The application provides services.events through its existing services factory. Successful results equal the returned JSON; failures expose only code/status. A send failure leaves the commit/response unchanged and produces one error log. Apply readonly to every field of the public event draft below and use the callback type `(event: PublicResponseEvent<TContext, TServices>) => void | Promise<void>`.

## Completed verification and implementation checks

The existing `pnpm --filter @takibi/invocation-lifecycle exec vp test tests/invocation.test.ts` completed with **34 tests passed**. This verifies the existing lifecycle; the new onResponse is neither implemented nor tested. In addition to the original acceptance criteria, verify that nested result/ctx mutations cannot reach the response or later batch items, notification.failed produces one single/batch log, behavior is compatible without an observer, and there is no delivery guarantee across client retries. If the original ADR is found, check its constraints; if its prohibition also covers observation, reassess the rationale for adopting the public API in the ADR.

## Retained detailed specification and acceptance criteria

## Problem

Takibi's public execution units are collection CRUD, actions, and batch items, but `createTakibi`
does not expose a supported completion callback. Applications that enqueue notifications, audit-like
records, or index updates after successful actions must repeat dispatch code in every handler;
omission becomes a missed event.

`@takibi/invocation-lifecycle` now already owns settlement followed by awaited, at-most-once,
failure-isolated notification. `@takibi/worker-runtime` supplies an internal
`invocationNotify` adapter that currently defaults to `undefined`. The missing work is a narrow,
privacy-conscious public projection and configuration path, not another lifecycle mechanism.

This observer is not a fail-closed audit control. Applications needing tamper-resistant atomic audit
records must write inside the handler/transaction or use a separately designed outbox. Heavy work
should normally enqueue to a service such as Cloudflare Queues and complete in a consumer.

## Proposal

Add one optional `onResponse` callback to `ContextConfig` and both `CreateContextFn` overloads:

```ts
export type PublicResponseEvent<TContext extends object, TServices> = {
  invocation:
    | {
        kind: "collection";
        collection: string;
        operation: "add" | "get" | "list" | "set" | "update" | "delete";
        id?: string;
      }
    | { kind: "action"; scope: string; name: string; id?: string };
  result: { ok: true; data: JsonValue } | { ok: false; error: { code: string; status: number } };
  ctx: TContext;
  services: TServices;
};
```

The name describes a public Takibi response, not an HTTP `Response`. Invoke it after execution has
settled, but before returning the HTTP response. A failed settlement may have an unknown
transaction outcome; notification does not guarantee that rollback was confirmed.
Call once for a single CRUD/action and once per batch item, on both success and failure.

Success exposes exactly the JSON value used in the response. Failure exposes only normalized code
and status. Do not expose action/CRUD input, error message, validation issues, internal failure
objects, or reasons. The callback receives the resolved/current application context and services;
services are closure-bound by worker-runtime and are not structured-cloned into the generic event.

Await the callback. If it throws or rejects, emit a `takibi.onResponse` error log and preserve the
original response outcome and body. Requests that fail before an invocation is classified and
settled, such as HTTP decode or application context resolution failure, do not call it.

## Package boundaries

- `@takibi/invocation-lifecycle` remains generic and unchanged; it owns settle → snapshot → notify,
  at-most-once state, awaiting, and observer-failure isolation.
- `@takibi/worker-runtime` owns the Takibi-specific safe event projection, config wiring,
  service/context binding, and `takibi.onResponse` logging.
- `@takibi/api` or `@takibi/shared-types` may own the public event shape only if required to keep the
  facade small; internal lifecycle failure types must not become public.
- the `takibi` package facade exports the user-facing types without exposing adapter internals.

## Implementation notes

- Project invocation metadata from `TakibiPublicInvocation`; never pass the original wire object.
- Map the settled result/failure in the `invocationNotify` adapter and rely on the lifecycle runner's
  existing observer-failure isolation rather than adding try/catch at every response site.
- Keep response construction after the notified invocation result. The existing single and batch
  envelope runners should provide call counts and ordering.
- Wire the same config through the generated Durable Object and `withSqliteTestBackend` path.
- Add an RFC documenting this read-only completion boundary: it cannot join a transaction, alter
  handler output, or change the response. The original no-lifecycle-hooks ADR has not been located;
  record that uncertainty rather than asserting its rationale.

## Scope

In scope:

- public types and inference for optional `onResponse`;
- generated Durable Object and SQLite testing-backend wiring;
- single/batch, success/failure behavior and callback-failure logging;
- README and an RFC defining the observer boundary.

Out of scope:

- application Queue bindings/consumers or audit collections;
- fail-closed transaction hooks or an outbox;
- per-action builder hooks;
- public input, error messages/issues/reasons, or request-level idempotency.

## Acceptance criteria

- Single CRUD success/failure, action success/failure, and every batch item invoke `onResponse`
  exactly once with expected invocation/result metadata.
- Successful `result.data` equals the response value, including IDs returned by detached actions or
  add operations.
- Public types expose no action/CRUD input or error message, issues, reason, or internal failure.
- A throwing/rejecting observer leaves response status/body unchanged and emits one
  `takibi.onResponse` error event.
- Notification is awaited after transaction settlement and cannot roll back the operation.
- HTTP decode and context-resolution failures do not invoke the observer.
- Durable Object and SQLite testing paths have matching call count, order, and failure isolation.
- Existing `resolve`, `services`, action builder, and client inference remain unchanged.
- The ADR explicitly distinguishes observation from lifecycle mutation and fail-closed auditing.
- `vp check`, worker-runtime Node/Workers tests, testing package tests, and the repository-wide gate
  pass.
