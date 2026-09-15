---
title: Expose query compilation preflight and typed capacity failures
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Duplicated capacity logic can make the Better Auth adapter reject valid queries or fail after it is too late to choose its bounded fallback."
category: integration
source_issue: 0052-query-compilation-preflight
---

# Problem

`@takibi/query` builds and normalizes typed query ASTs, while `@takibi/protocol` enforces node,
depth, and `in`-value limits. The public `takibi` package root does not expose a supported preflight
API or an error type that distinguishes capacity overflow from other invalid queries.

`packages/better-auth-adapter/src/query.server.ts` must choose between pushdown and a bounded scan
before executing a collection operation. It currently duplicates Takibi's node/depth limits and
estimates the expanded AST shape of Better Auth operators. Drift can either send a valid query to a
slow fallback or let an oversized query reach Takibi after fallback is no longer selectable.

Exporting constants alone would still duplicate expansion and normalization logic. Takibi needs to
remain the single authority for the compiled shape.

# Proposal

Expose `compileWhere` through the public `takibi` package root and add a public
`QueryCapacityError extends TypeError`:

```ts
type QueryCapacityCode = "QUERY_MAX_NODES" | "QUERY_MAX_DEPTH" | "QUERY_IN_MAX_VALUES";

class QueryCapacityError extends TypeError {
  readonly code: QueryCapacityCode;
  readonly limit: number;
  readonly actual: number;
}
```

`compileWhere<TDoc>(callback)` must use the same typed builder and normalization path as collection
operations and return the normalized `QueryExpr` without touching storage.

Node, depth, and `in` cardinality overflow use `QueryCapacityError`. Empty `in`, non-scalar values,
operands from another builder, and unknown operators remain ordinary validation `TypeError`s. Error
metadata must contain no query values or document data.

The Better Auth adapter preflights its generated callback and selects bounded fallback only for
`QueryCapacityError`. It retains only Better-Auth-specific decisions about unsupported operators or
modes. Do not add a raw `QueryExpr` overload to collection APIs.

# Package boundaries

- `@takibi/protocol` owns AST shape and hard capacity limits.
- `@takibi/query` owns typed construction, normalization entry points, and capacity error creation.
- the public `takibi` facade re-exports the supported preflight contract.
- `@takibi/better-auth-adapter` consumes the public contract and owns only DSL translation and
  bounded fallback policy.

# Acceptance criteria

- `compileWhere`, `QueryCapacityError`, and `QueryCapacityCode` are importable from `takibi`.
- Preflighting an in-capacity callback returns the same normalized expression used by list/count.
- Node, depth, and `in` cardinality overflows report code, limit, and actual count.
- Other malformed queries remain ordinary validation errors and are not hidden by fallback.
- Better Auth contains no copied Takibi node/depth limits or `estimateQueryShape`.
- Capacity overflow still triggers the configured bounded scan, including oversized `in` lists.
- In-capacity list, count, and trusted mutations do not take the fallback path.
- Query result semantics remain identical in Node SQLite and Workers tests.
- `vp check`, query tests, Better Auth Node/Workers tests, and the repository-wide gate pass.
