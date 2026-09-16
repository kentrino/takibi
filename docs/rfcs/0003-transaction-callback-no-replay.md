---
id: "0003"
title: Transaction callback no-replay contract
status: proposed
created: 2026-09-16
implementation_issues:
  - ../issues/open/0020-transaction-callback-no-replay/issue.md
---

# Transaction callback no-replay contract

## Proposed contract

`StorageDriver.transaction(callback)` invokes `callback` at most once for each
transaction call in an invocation attempt. It may invoke it zero times when
transaction admission fails. A nested transaction joins its enclosing transaction,
and its explicitly supplied callback is likewise invoked at most once. Storage
decorators and other supported wrappers must preserve this property.

An execution error, rollback, commit error, or unknown commit outcome must not cause
the runtime, driver, or wrapper to transparently replay application work. Existing
error and settlement behavior remains unchanged; this proposal adds no public API,
wire-format, or persistence change.

Atomic action handlers and trusted local `$transaction` callbacks inherit this
contract. It applies only to one call in one invocation attempt. It does not provide
distributed exactly-once delivery, make external effects transactional, or
deduplicate a new HTTP request, client retry, or separate invocation.

```ts
await this.$collections.$transaction(async ($collections) => {
  await $collections.orders.add(order);
  await sendNotification(order.id);
});
```

The callback is not transparently replayed during this attempt. Nevertheless, the
notification may have happened when commit fails or its outcome is unknown, and a
caller retry may send it again. Applications that require durable delivery still
need an idempotency or outbox design.

## Why

Transaction callbacks can perform HTTP requests, send messages, or mutate memory;
none can be rolled back with collection writes. Permitting an implementation to
replay such work would silently duplicate effects. The SQLite adapter currently
delegates one callback and nested calls join a scoped driver, while existing backend
[research](../issues/open/0012-turso-backend-feasibility/issue.md) requires no replay.
That is evidence that the contract is feasible, not
proof that every supported path conforms.

## Alternative

The main alternative is to permit replay and require every callback to be
idempotent. That preserves freedom for retrying backends but changes the programming
model and cannot by itself make arbitrary external effects exactly once. Forbidding
external effects is not practically enforceable, and leaving execution count
unspecified preserves the correctness hazard.

## Verification

Contract tests should cover the underlying SQLite transaction behavior and every
supported wrapper for success, admission failure, callback failure, nested scopes,
commit failure, and unknown outcomes. Counts must be checked independently from
invocation retries. A deliberately replaying test double should prove the suite
detects a violation. The runtime must reject or leave unsupported such a driver,
not silently repair arbitrary replaying implementations.

These are proposed checks, not completed conformance verification. Exercise both
the local adapter and Workers backend; a single delegation in the adapter does
not establish the underlying platform's callback-count guarantee.
