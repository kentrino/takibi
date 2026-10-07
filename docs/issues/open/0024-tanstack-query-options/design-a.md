# Design A: `@takibi/jotai` package with `takibiQueryOptions` factory

## Example

Proposed API; not implemented. The package provides a factory that wraps `queryFn` to unwrap `TakibiResult` internally.

```ts
// Before: users write unwrapTakibi at every queryFn
import { unwrapTakibi, TakibiFailureError } from "takibi/client";

const postsAtom = atomWithQuery(() => ({
  queryKey: ["posts"],
  queryFn: async () => unwrapTakibi(await client.posts.list()),
}));

// After: users pass the Result-returning function directly
import { takibiQueryOptions } from "@takibi/jotai";

const postsAtom = atomWithQuery(() =>
  takibiQueryOptions({
    queryKey: ["posts"],
    queryFn: () => client.posts.list(),
  })
);
```

For mutations, the factory also handles invalidation:

```ts
const createPostAtom = atomWithMutation(() =>
  takibiMutationOptions({
    mutationFn: (input: PostInput) => client.posts.add(input),
    invalidate: ["posts"],
  })
);
```

## Why a separate package

The concern `docs/concerns/0002-jotai-tanstack-query-adapter/concern.md` compares four options. Option D (separate package) is chosen because:

1. **No atom-specific API**: tRPC and oRPC do not provide Jotai-specific atoms. They provide `queryOptions` factories, and Jotai users pass them to `atomWithQuery`. Takibi should follow the same pattern.

2. **Hide unwrap logic**: Option B exposes `unwrapTakibi` to users, requiring them to write it at every call site. The factory hides this internally.

3. **Dependency isolation**: Option C adds `jotai` and `@tanstack/query-core` as peer dependencies to the main `takibi` package. A separate package keeps these dependencies isolated, following the precedent of `@takibi/hono-adapter` and `@takibi/better-auth-adapter`.

## Factory behavior

`takibiQueryOptions` accepts the same options as TanStack Query's `queryOptions`, except `queryFn` returns `Promise<TakibiResult<T>>` instead of `Promise<T>`. The factory wraps `queryFn` to:

1. Call the original `queryFn` to get `TakibiResult<T>`.
2. If `ok: true`, return `data`.
3. If `ok: false`, throw `TakibiFailureError` with the failure.

The thrown error must preserve the full `TakibiFailure` type, including `reason.code` for policy denials. Users can narrow the error in `onError` or error boundaries using `instanceof TakibiFailureError` and then inspecting `error.failure`.

For mutations, `takibiMutationOptions` additionally accepts an `invalidate` option that specifies query keys to invalidate on success. This matches the pattern in the concern's `atomWithTakibiMutation`.

## Type inference

The factory must preserve type inference so that:

- `data` in `useQuery` is `T`, not `TakibiResult<T>`.
- `error` in `useQuery` is `TakibiFailureError<TReasonCode>`, not `unknown`.
- `TReasonCode` is inferred from the collection's policy reason codes.

This requires generic type parameters on the factory that mirror the client's type parameters.

## Peer dependencies

The package declares:

```json
{
  "peerDependencies": {
    "jotai": "^2.0.0",
    "jotai-tanstack-query": "^0.8.0",
    "@tanstack/query-core": "^5.0.0",
    "takibi": "workspace:*"
  }
}
```

Users install only what they need. React users who do not use Jotai can use the factory with `useQuery` directly.

## Alternatives considered

- **Option B (expose `unwrapTakibi` only)**: Rejected because it requires users to write `unwrapTakibi` at every call site, which is the original problem.
- **Option C (`takibi/jotai` subpath)**: Rejected because it adds peer dependencies to the main package, increasing its install size and version coupling.
- **Atom-specific API (`atomWithTakibiQuery`)**: Rejected because tRPC and oRPC do not provide this; `queryOptions` is sufficient.

## Compatibility and verification

This is a new package with no changes to existing code. The factory must be tested with:

- Query success and failure cases, verifying `data` and `error` types.
- Mutation success and failure cases, verifying invalidation.
- Policy denial with `reason.code`, verifying type narrowing.
- Integration with `atomWithQuery` and `atomWithMutation` from `jotai-tanstack-query`.
- Integration with `useQuery` and `useMutation` from `@tanstack/react-query`.

The package must not depend on React; it should work with any TanStack Query adapter (React, Vue, Solid, etc.).
