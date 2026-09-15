---
title: Authorize list and count with policy-owned query ranges
author: OpenAI Codex
cost: 5
priority: P1
priority_reason: "List authorization still makes applications prove client filters imply owner constraints; this is a design gap, not a demonstrated bypass."
category: security
source_issue: 0059-policy-owned-list-scope
supersedes: 0015-policy-owned-list-scope
---

[日本語](./issue.ja.md)

# Problem

Policy-bound `list` and `count` grant a permission, then execute the
client-requested `where`. Applications that want owner, admin, or public-record
ranges must prove the client filter implies those constraints. That is an
authorization-design gap (P1), not a demonstrated P0 bypass.

# Outcome

Implement the accepted contract in [design-01.md](./design-01.md): grants carry
`deny` / `allowAll` / `allowWhere(QueryExpr)` list decisions; runtime composes
an effective query once per operation; storage executes that query and binds
cursors without putting server scope in the token.

Supersedes
[0015-policy-owned-list-scope](../../closed/0015-policy-owned-list-scope/issue.md).
Future watch in
[0007-realtime-query-watch](../0007-realtime-query-watch/issue.md) must reuse
this path and is not part of this issue.

# Related Files

- `packages/policy/src/policy.ts`
- `packages/policy/src/types.ts`
- `packages/api/src/types.ts`
- `packages/api/src/action.ts`
- `packages/query/src/query.ts`
- `packages/protocol/src/query.ts`
- `packages/worker-runtime/src/executor.ts`
- `packages/worker-runtime/src/invocation-collaborators.ts`
- `packages/worker-runtime/src/context/types.ts`
- `packages/storage/src/storage.ts`
- `packages/storage/src/indexes.ts`
- `packages/takibi/docs/recipes/owner-scoped-collections.md`
- `packages/takibi/README.md`
