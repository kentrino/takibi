---
title: Expose an onResponse observer for completed public invocations
author: OpenAI Codex
cost: 5
priority: P1
priority_reason: "A concrete application otherwise duplicates post-response dispatch across many actions, and the generic lifecycle already provides isolated at-most-once notification."
category: observability
source_issue: 0063-onresponse-observer
---

# Problem

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

# Proposal

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
settled and its transaction has committed or rolled back, but before returning the HTTP response.
Call once for a single CRUD/action and once per batch item, on both success and failure.

Success exposes exactly the JSON value used in the response. Failure exposes only normalized code
and status. Do not expose action/CRUD input, error message, validation issues, internal failure
objects, or reasons. The callback receives the resolved/current application context and services;
services are closure-bound by worker-runtime and are not structured-cloned into the generic event.

Await the callback. If it throws or rejects, emit a `takibi.onResponse` error log and preserve the
original response outcome and body. Requests that fail before an invocation is classified and
settled, such as HTTP decode or application context resolution failure, do not call it.

# Package boundaries

- `@takibi/invocation-lifecycle` remains generic and unchanged; it owns settle → snapshot → notify,
  at-most-once state, awaiting, and observer-failure isolation.
- `@takibi/worker-runtime` owns the Takibi-specific safe event projection, config wiring,
  service/context binding, and `takibi.onResponse` logging.
- `@takibi/api` or `@takibi/shared-types` may own the public event shape only if required to keep the
  facade small; internal lifecycle failure types must not become public.
- the `takibi` package facade exports the user-facing types without exposing adapter internals.

# Implementation notes

- Project invocation metadata from `TakibiPublicInvocation`; never pass the original wire object.
- Map the settled result/failure in the `invocationNotify` adapter and rely on the lifecycle runner's
  existing observer-failure isolation rather than adding try/catch at every response site.
- Keep response construction after the notified invocation result. The existing single and batch
  envelope runners should provide call counts and ordering.
- Wire the same config through the generated Durable Object and `withSqliteTestBackend` path.
- Add an ADR that reconciles this read-only completion observer with the prior no-lifecycle-hooks
  decision: it cannot join a transaction, alter handler output, or change the response.

# Scope

In scope:

- public types and inference for optional `onResponse`;
- generated Durable Object and SQLite testing-backend wiring;
- single/batch, success/failure behavior and callback-failure logging;
- README and an ADR defining the observer boundary.

Out of scope:

- application Queue bindings/consumers or audit collections;
- fail-closed transaction hooks or an outbox;
- per-action builder hooks;
- public input, error messages/issues/reasons, or request-level idempotency.

# Acceptance criteria

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
