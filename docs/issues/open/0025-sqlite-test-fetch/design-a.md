# Design A: `testFetch(handler, options)` from `takibi/testing`

## Example

Proposed API; not implemented.

```ts
// Before: each package copies this helper into tests/helpers/request.ts
export async function requestTakibi(handler, input, init) {
  const result = await handler.handle(new Request(input, init), { context: {} });
  if (!result.matched) throw new Error("Expected a matching Takibi test request");
  return result.response;
}

// After: one library-provided adapter
import { testFetch } from "takibi/testing";

const handler = withSqliteTestBackend(takibiHandler, {
  resolve: resolveFromTestHeader,
});
const client = createClient<typeof takibiHandler>("https://app.test", {
  fetch: testFetch(handler),
  headers: { "x-test-user": JSON.stringify({ id: "u1", role: "member" }) },
});
```

`options` carries the `HandleOptions` tests already pass by hand, so the
realtime-chat example keeps its room routing:

```ts
fetch: testFetch(handler, {
  context: { room },
  stripPrefix: `/api/${room}`,
});
```

## Why a standalone function

`TestingForkHandler` is a `Pick` of the production handler surface plus
`Disposable`, with the explicit note that forks recreate the standard handler
surface. A standalone `testFetch(handler)` keeps the fork surface identical to
production and keeps the adapter in `@takibi/testing`, which already depends on
`@takibi/worker-runtime`. Adding a `fetch` property to the handler instead
would make the testing handler diverge from the production shape it stands in
for.

Both shapes satisfy the README contract. If the property shape is preferred,
rename the documented `handler.request` to `handler.fetch` so the example
stays accurate.

## Behavior

- Build `new Request(input, init)`, call `handler.handle(request, options)`,
  throw when `matched` is false, otherwise return `response`.
- `options.context` is the initial context for every request through this
  adapter. Its type is the forked handler's input type: an explicit replacement
  resolver can define a narrower test input, while a fork without one keeps the
  production input type ([issue 0021](../../closed/0021-sqlite-test-context-input/issue.md)).
- Per-user variation is out of scope here;
  [issue 0026](../0026-sqlite-test-typed-client/issue.md) layers per-user
  clients on this adapter.

## Compatibility and verification

- Pure addition to `takibi/testing`; no runtime behavior changes.
- Type checks: the adapter is assignable to `createClient`'s `fetch` option;
  handlers with an empty input type call `testFetch(handler)` without options;
  non-empty inputs require `context`.
- Runtime tests: a matched request returns the handler's response; an
  unmatched request throws; `stripPrefix` is forwarded.
- Migrate the five `tests/helpers/request.ts` copies, the realtime-chat
  closure, and the README example; delete the helpers.
