---
title: Separate mandatory list scope from client-supplied query filters
author: OpenAI Codex
cost: 5
priority: P0
priority_reason: "A single owner-scope policy mistake can expose an entire collection across users, and Takibi currently provides no server-enforced row scope."
category: security
source_issue: 0059-policy-owned-list-scope
status: closed
closed_reason: superseded
replacement: ../0018-policy-owned-list-range/issue.md
---

[日本語](./issue.ja.md)

# Status

Closed as superseded by
[0018-policy-owned-list-range](../0018-policy-owned-list-range/issue.md).
The decided contract is in
[design-01.md](../0018-policy-owned-list-range/design-01.md).
Do not implement the collection-level `listScope` proposal from this issue.

# Why this was replaced

The original write-up treated missing server-owned list scope as a P0 bypass.
Current list policy still requires the `list` permission, and
`queryImpliesEquality` conservatively walks `and`/`or` and rejects `not`. There
is no demonstrated authorization bypass.

The remaining problem is authorization design: applications must prove that a
client filter implies owner or similar constraints, and a separate unconditional
collection ceiling cannot compose owner, admin, and public-record grants. Those
rules belong on policy-owned list ranges, not on an independent `listScope`
callback.

# Historical problem

Document policy receives `doc` / `nextDoc`, but list policy receives no
document. An owner-scoped list is safe today only if application policy proves
that an arbitrary client Boolean AST implies `ownerId = currentUser`. Clients
must repeat that constraint on every view-specific filter. After a grant,
worker-runtime executes the requested query as supplied.

# Historical proposal (not accepted)

Add `listScope` to collection definitions, AND it with the requested filter, and
bind cursors to the combined effective query. `accessPolicy` would only grant or
deny `list`. That ceiling duplicates admin exceptions and owner rules and cannot
express per-grant ranges.
