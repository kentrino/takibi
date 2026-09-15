---
title: Expose authoritative query preflight and typed capacity failures
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Duplicated capacity logic can make the Better Auth adapter reject valid queries or fail after it is too late to choose its bounded fallback."
category: integration
source_issue: 0052-query-compilation-preflight
---

# Expose authoritative query preflight and typed capacity failures

Better Auth duplicates Takibi node/depth budgets and estimates query expansion to choose pushdown or a bounded fallback before execution. Expose compileWhere and typed capacity failures from takibi so the adapter uses the same compilation path as collection operations. Remove copied capacity logic while preserving validation errors, public/server budget separation, and list/count/trusted-mutation results; raw AST collection overloads are out of scope.

[Design](./design-a.md)

## Related Files

- `packages/query/src/query.ts` — typed compilation and in validation
- `packages/protocol/src/query.ts` — public/server budgets and normalization
- `packages/protocol/src/error.ts` — TypeError-compatible protocol errors
- `packages/query/src/list-scope.ts` — server-owned scope composition
- `packages/takibi/src/index.ts` — supported public exports
- `packages/better-auth-adapter/src/query.server.ts` — duplicated estimation and fallback selection
