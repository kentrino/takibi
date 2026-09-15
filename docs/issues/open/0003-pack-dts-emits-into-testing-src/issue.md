---
title: Stop worker-runtime pack dts from emitting declarations into testing sources
author: Kimi K3 (Droid Core)
cost: 2
priority: P1
priority_reason: "The defect makes clean build and release gates nondeterministic and can emit generated files into another package's sources."
category: build
---

# Problem

`@takibi/worker-runtime` aliases `@takibi/testing` to source files so tests avoid a dependency
cycle (introduced in `becf2c9`):

- `packages/worker-runtime/tsconfig.json` maps `@takibi/testing` to `../testing/src/index.ts` and
  `@takibi/testing/sqlite-storage` to `../testing/src/sqlite-storage.server.ts`;
- `packages/worker-runtime/vite.config.ts` repeats the same aliases for Vitest.

The `pack.dts` build (`tsgo: true`) follows those `paths` aliases while generating declarations for
the `testing-bridge` entry. Because the aliased files live outside the worker-runtime root, tsgo
cannot map them into `dist/` and emits declarations beside the testing sources instead:

```text
packages/testing/src/index.d.ts
packages/testing/src/sqlite-storage.server.d.ts
packages/testing/src/testing.server.d.ts
```

These files collide with the `@takibi/testing` package-boundary test "source implementations have
no duplicate generated declarations", which asserts that declarations are generated in `dist/` only.
Whether `pnpm ready` fails depends on task ordering: if the worker-runtime build finishes before
the testing boundary test runs, the gate fails; otherwise it passes. Cold builds (no task cache)
make the failure likely, so the repository's own ready gate is nondeterministic.

Reproduction:

```sh
rm -f packages/testing/src/*.d.ts
pnpm --filter @takibi/worker-runtime build   # stray declarations reappear
pnpm --filter @takibi/testing test           # boundary test fails
```

# Proposal

Keep the source alias for tests, but decouple the pack dts build from it so that
`@takibi/testing` resolves as an external package during declaration generation. The published
`testing-bridge` declaration should reference `@takibi/testing` by package name (matching the
runtime import), not inline or re-emit its sources.

Candidate approaches, in preference order:

1. Point the pack dts step at a dedicated tsconfig without the source `paths` aliases (or with
   aliases that resolve to `@takibi/testing` dist declarations), if `vp pack` supports selecting a
   tsconfig for dts.
2. Configure the dts bundler to treat `@takibi/testing` as external so its declarations are never
   program files of the worker-runtime emit.
3. As a last resort, remove the stray files in a post-pack step; this hides the symptom and keeps
   the emit nondeterminism, so prefer a resolution-side fix.

# Scope

In scope:

- `packages/worker-runtime/vite.config.ts` and/or tsconfig setup used by `vp pack` dts;
- verification that the published `dist/testing-bridge.d.mts` still type-checks and references
  `@takibi/testing` correctly.

Out of scope:

- changing the test-time alias itself (it exists to avoid the test cycle);
- the testing package-boundary test, which is behaving as intended.

# Acceptance criteria

- `pnpm --filter @takibi/worker-runtime build` emits nothing under `packages/testing/src/`;
- `pnpm ready` passes deterministically from a clean, cache-free state;
- `pnpm test:e2e` passes, and the packed worker-runtime declarations for `testing-bridge` resolve
  `@takibi/testing` as an external package.
