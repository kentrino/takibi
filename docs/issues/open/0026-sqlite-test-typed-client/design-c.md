# Design C: `backend.client(initial)` on the testing handler

Rejected; kept from the previous proposal for reference. See
[Design A](./design-a.md) for the recommendation.

## Example

Proposed API; not implemented.

```ts
using backend = withSqliteTestBackend(takibiHandler, {
  resolve: ({ context }: { request: Request; context: { user: User } }) => ({
    tenantId: "t",
    user: context.user,
  }),
});
const admin = backend.client({ user: { id: "u1", role: "admin" } });
const member = backend.client({ user: { id: "u2", role: "member" } });
```

The previous example omitted the resolver annotation. After issue 0021 that
form types `context` as `Record<never, never>`, so `context.user` would not
compile.

## Why rejected

- `TestingForkHandler` deliberately recreates only the production handler
  surface (`handle`, `DurableObject`, the brand) plus `Disposable`. Issue 0025
  rejected adding `fetch` to that surface for the same reason. A `client`
  method would make the fork diverge from the production handler that it
  replaces.
- The fork object is built in `@takibi/worker-runtime`. Either worker-runtime
  gains a client dependency, or `@takibi/testing` wraps the fork and has to
  keep the brand, `DurableObject`, and disposal intact. Design B has the same
  user-facing gain without either cost.
- Choosing whether a backend-level default context merges with or is replaced
  by the per-client value is an extra decision that Designs A and B avoid.
