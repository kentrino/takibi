---
title: Separate mandatory list scope from client-supplied query filters
author: OpenAI Codex
cost: 5
priority: P0
priority_reason: "A single owner-scope policy mistake can expose an entire collection across users, and Takibi currently provides no server-enforced row scope."
category: security
source_issue: 0059-policy-owned-list-scope
---

# Problem

Document policy receives the stored `doc` or validated `nextDoc`, but list policy receives no
document. An owner-scoped list is safe only if application policy proves that an arbitrary
client-supplied Boolean AST implies `ownerId = currentUser`.

Searching for a matching leaf is unsafe because `or` and `not` can include another owner's rows.
`queryImpliesEquality` helps perform the proof, but every application must still use the helper
correctly and clients must repeat an authorization constraint in every view-specific filter. One
policy mistake can expose a whole collection because worker-runtime executes the client query after
policy grants list access; Takibi has no mandatory server-owned result scope.

# Proposal

Add a typed `listScope` to collection definitions:

```ts
const posts = context.defineCollection({
  schema: postSchema,
  accessPolicy: memberPolicy,
  listScope: ({ user }, query) => query.ownerId.eq(user.id),
});
```

`listScope` receives resolved application context and a schema-bound `QueryBuilder` and returns a
mandatory `QueryExpr`. For policy-bound list and count, combine it with the requested filter as
`and(scope, requested)` and normalize the combined effective query before index planning, SQL
compilation, and cursor binding. A client may omit or contradict the owner condition but cannot
weaken the server-owned scope with `or` or `not`.

`accessPolicy` still grants or denies the list permission; `listScope` never creates a grant. Trusted
`$collections` continue bypassing both policy and scope. A collection without `listScope` keeps its
current behavior.

# Package boundaries

- `@takibi/api` owns the schema-bound collection-definition type.
- `@takibi/query` owns construction of the scope expression and effective-query composition.
- `@takibi/protocol` owns normalization/capacity rules and cursor query fingerprints.
- `@takibi/worker-runtime` invokes scope only on policy-bound list/count and keeps requested versus
  effective query values distinct during policy and execution.
- `@takibi/storage` receives only the normalized effective query for planning and execution; it does
  not receive application context or invoke policy callbacks.

# Implementation notes

- Pass only resolved context and the typed query builder to `listScope`, not `Request`, services, or
  raw storage.
- Preserve `AccessContext.where` as the client-requested query. If observability needs the combined
  value, add a clearly named `effectiveWhere` rather than silently changing policy input.
- Apply node/depth/cardinality limits after combining scope and requested query and document that
  mandatory scope consumes part of the capacity budget.
- Bind cursors to the effective query so reuse under another identity or scope fails with
  `BAD_REQUEST`.
- Use the effective query for index equality prefixes and ranges so an owner field can be an index
  prefix.
- Replace the owner-scoped README recipe that asks clients to prove implication.
- Convert scope callback failure to a policy-safe error with no document values.

# Scope

In scope:

- mandatory per-collection list/count scope;
- normalization, capacity, cursor, and index integration;
- public requests and policy-bound collection facades inside actions;
- types, documentation, and security regression tests.

Out of scope:

- applying scope to trusted collections;
- changing get/update/delete document policy;
- adding an owner field to application schemas;
- projection, redaction, joins, or a global tenant filter.

# Acceptance criteria

- A scoped collection returns only the current owner's documents when the client omits owner filters.
- `or`, `not`, and a conflicting owner equality cannot escape the mandatory scope.
- Policy denial still returns `FORBIDDEN` regardless of scope.
- Policy-bound list across all pages and count use the same effective result set.
- Indexed queries use scope-derived equality prefixes with correct range, order, and cursor behavior.
- Reusing a cursor under a different resolved identity/scope is rejected.
- Trusted list/count bypass scope, while unscoped collections preserve current types and results.
- Type tests reject fields not present in the collection schema inside `listScope`.
- Query capacity is enforced after composition and scope failure exposes no protected values.
- `vp check`, API/query/protocol tests, worker-runtime Node/Workers security tests, and the
  repository-wide gate pass.
