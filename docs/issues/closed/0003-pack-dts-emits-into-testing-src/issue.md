---
title: Stop worker-runtime pack dts from emitting declarations into testing sources
author: Kimi K3 (Droid Core)
cost: 2
priority: P1
priority_reason: "The defect makes clean build and release gates nondeterministic and can emit generated files into another package's sources."
category: build
status: closed
closed_reason: implemented
---

# Keep declaration generation out of testing sources

Resolved by `c416df0dc28499549cb84c27d52b266ec94cd0b5`: the worker-runtime pack build
uses `tsconfig.pack.json`, which removes test-only source aliases and includes only `src`.
Test-time aliases remain available; no cleanup hook or weakened boundary test is needed.
The current testing bridge also no longer imports `@takibi/testing`, so the former requirement
that its declarations reference that package is obsolete; the dependency direction is now
testing → worker-runtime/testing-bridge.

Rechecked against `40eb8ea` on 2026-09-16: `pnpm --filter @takibi/worker-runtime build`
passed, followed by testing package-boundary tests (6 passed) and worker-runtime
package-boundary tests (3 passed), using `pnpm --filter <package> exec vp test
tests/package-boundary.test.ts`. No duplicate declarations appeared in testing sources.
`pnpm test:e2e` passed packed-package checks, consumer execution, and both consumer
TypeScript configurations. The entire cache-free `pnpm ready` gate was not rerun;
closure rests on the existing resolution fix and the direct build/boundary reproduction.

## Related Files

- `packages/worker-runtime/vite.config.ts` — dedicated declaration-build configuration
- `packages/worker-runtime/tsconfig.pack.json` — source-only emit without testing aliases
- `packages/worker-runtime/tsconfig.json` — retained test-time aliases
- `packages/worker-runtime/src/testing-bridge.server.ts` — current dependency direction
- `packages/worker-runtime/tests/package-boundary.test.ts` — runtime dependency checks
- `packages/testing/tests/package-boundary.test.ts` — rejects declarations beside sources
- `e2e/run.ts` — packed consumer and declaration verification
