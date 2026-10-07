# Design A: `backend.client(initial)` with the resolver still running

## Example

Proposed API; not implemented.

```ts
// Before: context round-trips through a header
const handler = withSqliteTestBackend(takibiHandler, {
  resolve: ({ request }) => ({
    tenantId: "t",
    user: JSON.parse(request.headers.get("x-test-user")!),
  }),
});
const client = createClient<typeof takibiHandler>("https://app.test", {
  fetch: testFetch(handler),
  headers: { "x-test-user": JSON.stringify({ id: "u1", role: "member" }) },
});

// After: the initial context flows into the replacement resolver directly
using backend = withSqliteTestBackend(takibiHandler, {
  resolve: ({ context }) => ({ tenantId: "t", user: context.user }),
});
const admin = backend.client({ user: { id: "u1", role: "admin" } });
const member = backend.client({ user: { id: "u2", role: "member" } });
// admin and member share one database
```

## Why initial context, not resolved context

Passing the resolved context directly (a `clientAs(resolved)` shape) was
considered and rejected. It publishes a test path that never runs the
production resolver: tests built on it stop exercising authentication and
tenant extraction, the current fork model (one resolver per `mount`) would
need a separate per-request injection mechanism, and whether
`assertSerializableContext` applies to injected contexts would need a new
decision. Passing the initial context keeps the per-request resolve, the
existing serializability check, and the current fork model; the only new
surface is the client factory. The remaining cost over the resolved-context
shape is one trivial resolver per test file, which keeps the resolve path
under test.

## Behavior

- `backend.client(initial)` returns a `createClient` result whose `fetch` is
  the [issue 0025](../0025-sqlite-test-fetch/issue.md) adapter bound to
  `handler.handle(request, { context: initial })`.
- `initial` is typed as the replacement resolver's input type, which requires
  [issue 0021](../../closed/0021-sqlite-test-context-input/issue.md); with no resolver
  override it is the production input type.
- The base URL is a placeholder because the adapter intercepts the request;
  `createClient` options such as `headers` remain available for behavior that
  genuinely uses headers.
- One backend, many clients: `handle` already receives the initial context per
  request and the resolver runs per request, so per-user clients share the
  backend's single database with no new mechanism.

## Compatibility and verification

- Additive to `takibi/testing`; `@takibi/client` becomes a runtime dependency
  of `@takibi/testing`.
- Type tests: the `initial` argument tracks the replacement resolver's input
  type (empty and typed cases from issue 0021), and the returned client is
  typed on the handler.
- Runtime tests: two clients with different users share one database and
  observe each other's writes; the replacement resolver receives each client's
  initial context; a resolver output failing `assertSerializableContext` still
  fails.
- Migrate `packages/takibi/tests` and the README off the `x-test-user`
  pattern.
