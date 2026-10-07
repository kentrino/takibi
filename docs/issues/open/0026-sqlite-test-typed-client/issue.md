---
title: Obtain per-user typed clients from the SQLite test backend
author: Cursor Agent
cost: 2
priority: P2
priority_reason: "Switching test users requires encoding context into an x-test-user header and parsing it back in a replacement resolver, a pattern repeated across the README, repository tests, and integrating applications."
category: devex
---

# Obtain per-user typed clients from the SQLite test backend

Tests that exercise per-user authorization replace the production resolver with
one that reads a JSON-encoded user from the `x-test-user` header. The round
trip exists only because tests enter through `handle(request, ...)`; the
pattern is repeated in the README, `packages/takibi/tests`, and integrating
applications, and it puts context serialization into the test's precondition.
Each `withSqliteTestBackend` call creates an independent database, so tests
that share data across users must vary the context per request inside one
handler, which today is only possible through headers.

Completion requires obtaining a typed client bound to a caller-supplied initial
context from the test backend, keeping the production-shaped pipeline (resolve,
serializability check, execution) intact, and removing the header encoding from
repository tests and the README. The initial context type follows
[issue 0021](../0021-sqlite-test-context-input/issue.md); the underlying fetch
plumbing follows [issue 0025](../0025-sqlite-test-fetch/issue.md).

## Rules

- The replacement resolver still runs per request. Do not publish a test API
  that injects an already-resolved context bypassing `resolve`: such tests
  would stop exercising authentication and tenant extraction, the fork model
  (one resolver per `mount`) would need a separate per-request injection
  mechanism, and whether `assertSerializableContext` applies to injected
  contexts would need a new decision.
- The resolver's output continues through the existing
  `assertSerializableContext` check.
- `@takibi/testing` may promote `@takibi/client` from a devDependency to a
  runtime dependency; the direction introduces no cycle.

## Open Decisions

- Method name and shape on the test backend (`client(initial)`).
- Whether a backend-level default initial context merges with or is replaced
  by the per-client value.

[Design](./design-a.md)

## Related Files

- `packages/testing/src/testing.server.ts` — `withSqliteTestBackend` and `SqliteTestBackendOptions`
- `packages/worker-runtime/src/testing-bridge.server.ts` — `TestingForkHandler` surface
- `packages/worker-runtime/src/context/worker-call.ts` — per-request resolve and `assertSerializableContext`
- `packages/takibi/tests/takibi.test.ts` — `x-test-user` resolver and header helpers
- `packages/takibi/README.md` — header-based user switching example
- `docs/issues/open/0021-sqlite-test-context-input/issue.md` — prerequisite: replacement resolver defines its input type
- `docs/issues/open/0025-sqlite-test-fetch/issue.md` — prerequisite: fetch adapter this client wraps
