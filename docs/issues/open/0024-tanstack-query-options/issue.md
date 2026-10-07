---
title: Provide TanStack Query options factory as a separate package
author: Cursor Agent
cost: 2
priority: P2
priority_reason: "Applications using TanStack Query must manually unwrap TakibiResult at every queryFn, which is repetitive and error-prone."
category: enhancement
---

# Provide TanStack Query options factory as a separate package

Applications using TanStack Query with Takibi must write `unwrapTakibi(await client.posts.list())` at every `queryFn` and `mutationFn`. This is repetitive, and the unwrapping logic is identical across applications. The concern `docs/concerns/0002-jotai-tanstack-query-adapter/concern.md` documents this problem and compares four options.

Completion requires a new package `@takibi/jotai` (or `@takibi/tanstack-query`) that provides a `takibiQueryOptions` factory. This factory wraps `queryFn` to unwrap `TakibiResult` internally, so users write:

```ts
const postsAtom = atomWithQuery(() =>
  takibiQueryOptions({
    queryKey: ["posts"],
    queryFn: () => client.posts.list(),
  })
);
```

The factory must handle both queries and mutations, preserve type inference for `TakibiFailure`, and not require users to write `unwrapTakibi` or `TakibiFailureError` directly. The package must declare `jotai`, `jotai-tanstack-query`, and `@tanstack/query-core` as peer dependencies, following the precedent of `@takibi/hono-adapter` and `@takibi/better-auth-adapter`.

[Design](./design-a.md)

## Related Files

- `docs/concerns/0002-jotai-tanstack-query-adapter/concern.md` — original concern with four options
- `packages/takibi/package.json` — current public subpaths and dependency policy
- `packages/hono-adapter/package.json` — precedent for peer-dependency packages
- `packages/better-auth-adapter/package.json` — same precedent
- `packages/shared-types/src/index.ts` — `TakibiResult` and `TakibiFailure` types
- `packages/takibi/README.md` — "Types and UI ownership" section
