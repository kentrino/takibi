# Design B: `testClient(handler, options)` in `takibi/testing`

Alternative to [Design A](./design-a.md). Adopt only if repeated `clientAs`
wrappers show up across test files.

## Example

Proposed API; not implemented.

```ts
import { testClient, withSqliteTestBackend } from "takibi/testing";

using handler = withSqliteTestBackend(takibiHandler, {
  resolve: ({ context }: { request: Request; context: { user: User | null } }) => {
    if (context.user == null) throw new UnauthorizedError("Sign in required");
    return { tenantId: "test", principal: context.user };
  },
});

const admin = testClient(handler, { context: { user: { id: "u1", role: "admin" } } });
const member = testClient(handler, { context: { user: { id: "u2", role: "member" } } });
// Same behavior as Design A: one database, per-request resolve.
```

## Shape

```ts
export function testClient<H extends TestingClientHandler>(
  handler: H,
  options: HandleOptions<H[typeof TAKIBI_BRAND]["initial"]> & Omit<CreateClientOptions, "fetch">,
): ClientOf<H>;
```

- Implemented as `createClient<H>(PLACEHOLDER_URL, { ...clientOptions, fetch:
testFetch(handler, { context, stripPrefix }) })`.
- `HandleOptions` keys (`context`, `stripPrefix`) and `CreateClientOptions`
  keys (`headers`, `batch`, `listAll`, ...) do not overlap today. Any future
  overlap becomes a breaking ambiguity, which is the main maintenance cost.
- The base URL is hidden. `stripPrefix` remains for handlers mounted under a
  prefix (realtime-chat).

## Costs

- `@takibi/testing` moves `@takibi/client` from devDependencies to
  dependencies. The direction (testing → client → api) adds no cycle.
- Each new `CreateClientOptions` field must be considered for pass-through.
- `createWatchClient` has no equivalent. The SQLite backend does not emulate
  WebSockets, so this is consistent, but the gap needs a sentence in the docs.

## Verification

- Type tests: `options.context` follows the fork's input type (empty, typed,
  and inherited production input from issue 0021); the result equals
  `ClientOf<H>`; `fetch` is rejected in options.
- Runtime tests: the same as Design A, through `testClient`.
