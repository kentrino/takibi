# Design A: compose `testFetch` per user, add no client API

Recommended. Candidates:

- Design A (this file): one `createClient` per user, each bound to
  `testFetch(handler, { context })` from issue 0025. No new API.
- [Design B](./design-b.md): a `testClient(handler, options)` helper in
  `takibi/testing` that returns the typed client.
- [Design C](./design-c.md): a `backend.client(initial)` method on the testing
  handler (the previous proposal).

## Findings

Checked on the issue 0021 branch (`04212e4`):

- A replacement resolver annotated as
  `{ request: Request; context: { user: User } }` makes `handle` require that
  context. Two `createClient<typeof handler>` instances whose `fetch` calls
  `handler.handle(request, { context: { user } })` with different users share
  one database: an admin write was readable by the admin and denied to a member.
  This was a throwaway probe test with a hand-written adapter, not committed.
- The original premise, that switching users needs a header round trip, held
  only before issue 0021. The remaining per-user cost is the fetch adapter,
  which issue 0025 owns.
- The header resolvers in `packages/takibi/tests` (`resolveTestContext`) are
  the test apps' production resolvers passed to `createTakibi`, not replacement
  resolvers. They exercise request-derived identity, so migrating them is not
  required and stays out of scope.
- `ContextResolverInput` is exported from `@takibi/worker-runtime` and
  `@takibi/testing`, but not from the public `takibi` root or `takibi/testing`
  entries, so README examples write the resolver input type inline.

Not verified: the original issue says integrating applications copy the header
pattern. That claim affects priority, not the design.

## Example

Before (README today; `handler.request` does not exist, see issue 0025):

```ts
const handler = withSqliteTestBackend(takibiHandler, {
  resolve: ({ request }) => {
    const raw = request.headers.get("x-test-user");
    const user = raw == null ? null : JSON.parse(raw);
    if (user == null) throw new UnauthorizedError("Sign in required");
    return { tenantId: "test", principal: user };
  },
});
const client = createClient<typeof takibiHandler>("https://fire.test", {
  fetch: handler.request,
  headers: { "x-test-user": JSON.stringify({ id: "u1", role: "member" }) },
});
```

After (requires issue 0025's `testFetch`):

```ts
import { createClient } from "takibi/client";
import { testFetch, withSqliteTestBackend } from "takibi/testing";

type TestInput = { user: User | null };

using handler = withSqliteTestBackend(takibiHandler, {
  resolve: ({ context }: { request: Request; context: TestInput }) => {
    if (context.user == null) throw new UnauthorizedError("Sign in required");
    return { tenantId: "test", principal: context.user };
  },
});
const clientAs = (user: User | null) =>
  createClient<typeof handler>("https://fire.test", {
    fetch: testFetch(handler, { context: { user } }),
  });

const admin = clientAs({ id: "u1", role: "admin" });
const member = clientAs({ id: "u2", role: "member" });
// Both clients use one database; each request resolves its own principal.
// clientAs(null) requests fail with UNAUTHORIZED from the resolver.
```

Without the resolver annotation, `context` is `Record<never, never>` and
`context.user` is a type error. The README must show the annotation.

## Comparison

|                                                  | A: compose                       | B: `testClient` | C: `backend.client`      |
| ------------------------------------------------ | -------------------------------- | --------------- | ------------------------ |
| New public API                                   | none beyond 0025                 | one function    | one method               |
| Lines per user                                   | 3 (`createClient` + `testFetch`) | 1               | 1                        |
| `@takibi/client` at runtime in `@takibi/testing` | no                               | yes             | yes                      |
| Testing handler surface                          | unchanged                        | unchanged       | diverges from production |
| Client options (`headers`, `batch`, `listAll`)   | native                           | passed through  | passed through           |

A has no API surface to maintain, and each part already has an owner:
`createClient` builds the typed client, `testFetch` (issue 0025) adapts
`handle`, and the resolver (issue 0021) defines the input. B saves a placeholder
base URL and a type argument per test file. That saving only matters if many
call sites repeat the same `clientAs` wrapper, and it couples the testing
package to every client option. C was rejected for the reasons in
[Design C](./design-c.md).

Out of every candidate: a test API that injects an already-resolved context.
Tests built on it would stop exercising authentication and tenant extraction,
the fork model (one resolver per fork) would need a per-request injection
mechanism, and `assertSerializableContext` coverage for injected contexts
would need a new decision. Passing the initial context keeps the per-request
resolve and serializability check unchanged.

Adopt B later only if, after issue 0025 migrates the repository tests, three or
more test files define an identical `clientAs` wrapper.

## Changes

- `packages/takibi/README.md`: replace the "Node integration tests" example with
  the After example, explain the resolver annotation, and remove the
  `x-test-user` encoding. If issue 0025 already rewrote that example, extend it
  instead.
- `packages/testing/tests/handler.test.ts`: two clients with different initial
  contexts on one handler share documents; the replacement resolver receives
  each client's context; a resolver output that fails
  `assertSerializableContext` still fails the request.

## Compatibility and verification

- No runtime or type changes. Done after issue 0025 lands.
- Run the README example as a type test (or keep it equivalent to a test in
  `packages/testing/tests`) so the documented annotation keeps compiling.
- `pnpm run ready`.
