---
title: Provide a fetch-compatible adapter for SQLite test handlers
author: Cursor Agent
cost: 1
priority: P2
priority_reason: "The README's Node integration test example does not compile, and five packages each copy the same handle-to-fetch adapter into their test helpers."
category: devex
---

# Provide a fetch-compatible adapter for SQLite test handlers

The "Node integration tests" section of the README passes
`fetch: handler.request` to `createClient`, but the handler returned by
`withSqliteTestBackend` exposes only `handle`, `DurableObject`, and
`Symbol.dispose`. The documented property does not exist, so the example does
not compile. Every package works around the gap with an identical
`requestTakibi` helper in `tests/helpers/request.ts` (five copies: build a
`Request`, call `handle` with an empty context, throw when the result is not
`matched`, return the response), the realtime-chat example inlines the same
closure with `stripPrefix` and a room context, and integrating applications report
maintaining their own copy.

Completion requires a Takibi-provided adapter assignable to `createClient`'s
`fetch` option, support for the `handle` options tests already need (initial
context and `stripPrefix`), a loud failure for unmatched requests, README and
repository tests updated to use it, and the five helper copies deleted.

## Rules

- The adapter must satisfy the `fetch` type `createClient` accepts:
  `(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`.
- A `{ matched: false }` result must throw rather than fabricate a response.
- The initial context the adapter passes to `handle` follows the handler's
  input type. A replacement resolver can define the fork's test input, while
  omitting one preserves the production input type as implemented by
  [issue 0021](../../closed/0021-sqlite-test-context-input/issue.md).

## Open Decisions

- Exposure shape: a `fetch` property on the testing handler versus a
  standalone `testFetch(handler)` from `takibi/testing`.

[Design](./design-a.md)

## Related Files

- `packages/testing/src/testing.server.ts` — `withSqliteTestBackend` entry point
- `packages/worker-runtime/src/testing-bridge.server.ts` — `TestingForkHandler` surface (`handle` / `DurableObject` / `Disposable`)
- `packages/worker-runtime/src/context/http-handler.ts` — `handle` and `matched`
- `packages/worker-runtime/src/context/types.ts` — `HandleOptions` (`context`, `stripPrefix`)
- `packages/client/src/client.ts` — the `fetch` option type the adapter must satisfy
- `packages/takibi/README.md` — "Node integration tests" documents the nonexistent `handler.request`
- `packages/takibi/tests/helpers/request.ts` — one of the five duplicated adapters
- `examples/realtime-chat/tests/chat.test.ts` — inline adapter with `stripPrefix` and a room context
- `docs/issues/closed/0021-sqlite-test-context-input/issue.md` — owns the replacement resolver's input type
- `docs/issues/open/0026-sqlite-test-typed-client/issue.md` — builds per-user typed clients on this adapter
