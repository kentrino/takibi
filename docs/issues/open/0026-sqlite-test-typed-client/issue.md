---
title: Document per-user typed clients over one SQLite test backend
author: Cursor Agent
cost: 1
priority: P2
priority_reason: "The README still teaches switching test users by JSON-encoding them into an x-test-user header, although a typed initial context now carries the user without serialization."
category: devex
---

# Document per-user typed clients over one SQLite test backend

Authorization tests need several users against one shared SQLite test database.
The README's Node integration example switches users by JSON-encoding them into
an `x-test-user` header and parsing it back in a replacement resolver. Since
[issue 0021](../../closed/0021-sqlite-test-context-input/issue.md), a replacement
resolver can type its input context and `handle(request, { context })` passes a
different context per request, so per-user clients already work without the
header round trip. The supported pattern is undocumented and untested.

This is resolved when the README shows per-user typed clients sharing one
backend through the initial context, and tests prove that each client's context
reaches the replacement resolver and that its output still passes
`assertSerializableContext`. The pattern builds on the fetch adapter from
[issue 0025](../0025-sqlite-test-fetch/issue.md). Injecting an already-resolved
context that bypasses `resolve` stays out of scope.

[Design](./design-a.md)

## Related Files

- `packages/takibi/README.md` — "Node integration tests" header-based user switching example
- `packages/testing/src/testing.server.ts` — `withSqliteTestBackend` replacement resolver input
- `packages/testing/tests/handler.test.ts` — replacement resolver runtime tests
- `packages/worker-runtime/src/testing-bridge.server.ts` — `TestingForkHandler` surface
- `packages/worker-runtime/src/context/worker-call.ts` — per-request resolve and `assertSerializableContext`
- `packages/takibi/tests/takibi.test.ts` — header resolver used as a test app's production resolver
- `docs/issues/closed/0021-sqlite-test-context-input/issue.md` — replacement resolver defines the input type
- `docs/issues/open/0025-sqlite-test-fetch/issue.md` — prerequisite fetch adapter
