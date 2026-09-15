---
title: Policy-owned list and count ranges
author: OpenAI Codex
status: accepted
issue: ./issue.md
---

[日本語](./design-01.ja.md)

This is the accepted contract for
[0018-policy-owned-list-range](./issue.md).
It supersedes the collection-level `listScope` proposal in
[0015-policy-owned-list-scope](../../closed/0015-policy-owned-list-scope/issue.md).

# Decision

List and count authorization is a **policy-owned range**, not a separate
collection ceiling.

A grant's list decision is exactly one of:

- `deny` — no `list` permission
- `allowAll` — unrestricted list (`grant("list")`, `read`, `fullAccess` today)
- `allowWhere(QueryExpr)` — list only rows matching a server-built query

Owner, admin, and public-record rules compose through existing `and` / `or`.
Do not add `listScope` to `CollectionDefinition`.

# Current behavior

`packages/worker-runtime/src/executor.ts` evaluates collection policy with
`AccessContext.where` set to the requested filter, then
`executeResolvedCollection` passes that same `req.list` to storage.

`queryImpliesEquality` is conservative: an `and` succeeds if any operand
implies the equality, an `or` succeeds only if every operand does, and `not`
returns false. There is no demonstrated bypass. The cost is that applications
must prove client filters, as in
`packages/takibi/docs/recipes/owner-scoped-collections.md`.

`AccessGrant` is an empty branded object. Permissions and denial reasons live
in WeakMaps (`packages/policy/src/policy.ts`). `and` intersects permissions and
returns `none` when the set is empty. `or` unions permissions and returns the
`fullAccess` singleton when every permission is present. Scope must participate
in those early exits or composition will drop ranges.

Query normalization (`packages/protocol/src/query.ts`) validates and freezes.
It does not flatten or simplify. Limits are 32 nodes and depth 8. There are no
Boolean constants. Empty `and` / `or` are rejected.

List cursors (`packages/storage/src/storage.ts`) are unauthenticated base64url
JSON (v2/v3). They embed the full `where` and, for indexed scans, the last
row's index tuple. Equality is `JSON.stringify`. Substituting an effective
query into `where` would disclose server-only predicates.

# Accepted API

Keep `grant(...permissions)` and the catalog callback. Extend inputs with a
query-built scope token:

```ts
grant("get", listWhere((q) => q.ownerId.eq(user.id)));
grant("list"); // allowAll
```

`listWhere` lives in `@takibi/query` and is `compileWhere` plus a brand: the
callback must return a builder-created `QueryExpr`, which is then normalized
under the existing 32/8 client limits. The token type lives in
`@takibi/shared-types` so `@takibi/policy` can accept it without depending on
`@takibi/query`.

```ts
type ListWhereScope = {
  readonly kind: "listWhere";
  readonly where: QueryExpr;
};
```

`grant(listWhere(...))` grants `list` as `allowWhere`. A bare `"list"` in the
same call is `allowAll`; `allowAll` AND `allowWhere(W)` is `allowWhere(W)`.
Two `listWhere` tokens in one `grant()` AND together.

`read` and `fullAccess` stay `allowAll`. Constant `grant("get")` / `none` stay
`deny` for list. Unscoped `grant("list")` remains unrestricted.

Do not invent `grant.list.allowAll()` or a JS-to-SQL compiler. Field typing
uses `QueryBuilder<TDoc>`. Type tests must reject unknown fields; bind `TDoc`
from the collection schema (a schema-bound helper alias is allowed).

Export `listDecisionOf(grant)` from `@takibi/policy` for runtime. Store the
decision in a WeakMap beside permissions.

# Collection example

This example uses the proposed API; `listWhere` is not implemented yet.
Assume `z` is imported from `zod`, the policy helpers from `takibi`, and an
existing `context` resolves `user` as
`{ id: string; role: "admin" | "member" } | null`.

```ts
const postSchema = z.object({
  ownerId: z.string(),
  title: z.string(),
});

type Post = z.infer<typeof postSchema>;

const ownerReadPolicy = context.policy(
  postSchema,
  ({ user, operation, doc }) => {
    if (!user) return none;

    switch (operation) {
      case "list":
      case "count":
        return grant(
          listWhere<Post>((q) => q.ownerId.eq(user.id)),
        );
      case "get":
        return doc?.ownerId === user.id ? grant("get") : none;
      default:
        return none;
    }
  },
);

const adminReadPolicy = context.policy(({ user }) =>
  user?.role === "admin" ? read : none,
);

const posts = context.defineCollection({
  schema: postSchema,
  accessPolicy: or(adminReadPolicy, ownerReadPolicy),
  indexes: {
    byOwner: ["ownerId", "createdAt"],
  },
});
```

Owners can list/count their own posts and get their own documents. Admins can
read all posts; unauthenticated callers are denied. This example grants only
read operations.

Clients supply only the filter needed by the view:

```ts
await client.posts.list({
  where: (q) => q.title.contains("TypeScript"),
});
```

For a member, the effective query is `ownerId = user.id AND title contains
"TypeScript"`. An admin receives all posts matching the title filter.

`listWhere<Post>` explicitly supplies the schema-derived document type. The
exact helper for automatic schema inference is still to be settled; this
example does not assume that the surrounding `context.policy(postSchema, ...)`
automatically types the nested `listWhere` callback.

# Composition

Permissions stay independent of list range. A branch that grants `update` but
not `list` does not widen or narrow another branch's list range.

Conceptual operators on list decisions:

| left \ right | `deny` | `allowAll` | `allowWhere(W2)` |
| --- | --- | --- | --- |
| `deny` | `deny` | `deny` (and) / `allowAll` (or) | `deny` (and) / `allowWhere(W2)` (or) |
| `allowAll` | `deny` (and) / `allowAll` (or) | `allowAll` | `allowWhere(W2)` (and) / `allowAll` (or) |
| `allowWhere(W1)` | `deny` (and) / `allowWhere(W1)` (or) | `allowWhere(W1)` (and) / `allowAll` (or) | `allowWhere(and(W1,W2))` / `allowWhere(or(W1,W2))` |

`and` starts from all permissions and `allowAll`, then intersects each branch
(including list decisions) and still returns `none` when no permissions remain.

`or` starts from no permissions and `deny`, then unions. Only branches that
grant `list` contribute a range. `or` may return the `fullAccess` singleton
only when every permission is present **and** the list decision is `allowAll`.
A grant that has every permission but `allowWhere` must not intern to
`fullAccess`.

`composedGrant` follows the same intern rules. Denial reasons are unchanged.

# Runtime

Evaluate authorization and scope once per list/count:

1. Normalize the client `where` under existing 32/8 limits. This is the
   **requested** query. Keep it on `AccessContext.where`.
2. Evaluate `accessPolicy` exactly as today (`packages/worker-runtime/src/invocation-collaborators.ts`).
3. Policy denial stays `FORBIDDEN`. A grant without `list` is denial.
4. Derive the list decision from the grant. `undefined` is not `allowAll`.
5. Build the **effective** query:
   - `allowAll` → requested (possibly absent)
   - `allowWhere(S)` and no requested → `S`
   - `allowWhere(S)` and requested `W` → `composeAnd(S, W)`
6. Pass the effective query to storage **before** index planning, pagination,
   and count. Public HTTP and policy-bound action facades
   (`createPolicyCollections`) share this path.
7. Trusted `$collections` bypass policy and scope. Their effective query is the
   requested query.

Do not overwrite `AccessContext.where` with the effective query. Do not
implement watch here;
[0007-realtime-query-watch](../0007-realtime-query-watch/issue.md) must call
this same evaluate-and-compose path later.

# Fail-closed scope results

`listWhere` and composition must never treat a missing value as unrestricted:

- callback is not a function, throws, or returns a non-builder value → fail
  closed
- empty / invalid AST (including empty `and` / `or`) → fail closed
- composition overflow → fail closed

Surface these as a safe server error with no document values and no raw scope
AST in the client message. They are not `FORBIDDEN` and not `undefined`.

# Effective-query composition and capacity

`@takibi/query` owns `composeAnd` / `composeOr` over already-normalized
`QueryExpr` trees. They do not flatten, simplify, or introduce Boolean
constants. One operand returns that operand; two or more wrap a single
`and` / `or` node (existing shape, at least two operands).

Client ingest stays 32 nodes / depth 8. Each `listWhere` result uses that same
budget. Do not raise client limits because a server scope exists.

Composed **policy** ranges and `and(scope, requested)` use a separate server
budget: **64 nodes / depth 16**, owned next to the existing constants in
`@takibi/protocol`. Overflow fails closed. This is not a client relaxation and
must not depend on nonexistent simplification.

# Cursors

Cursors stay in `@takibi/storage`. Do not move them to protocol.

Introduce **list cursor v4**. Reject v2 and v3 after this ships (old tokens
embed `where` and have no binding).

```ts
type ListCursorV4 = {
  v: 4;
  collection: string;
  requestedWhere: QueryExpr | null;
  binding: string; // base64url(SHA-256(utf8(JSON.stringify(effectiveWhere ?? null))))
  id: string;
  // indexed only:
  index?: string;
  fields?: readonly string[];
  orderField?: string;
  direction?: "asc" | "desc";
  values?: readonly (string | number)[];
};
```

`StorageListOptions.where` becomes the **effective** query used for planning
and execution. Add `requestedWhere` for cursor compatibility (defaults to
`where` on the trusted path).

Every continuation **reauthorizes**. Then require:

- `cursor.requestedWhere` equals this request's requested query
- `cursor.binding` equals the digest of this request's effective query
- collection / index / order fields match (same as v3)

Effective-query compatibility is **not** identity binding. Distinct principals
that compose to the same effective AST may reuse a cursor. Do not put user id,
`tenantId`, or another reserved context key in the token.

## Guarantees (honest)

The binding is an **unkeyed SHA-256 digest** of the canonical normalized AST
(`JSON.stringify` of the frozen tree; operand order is significant because
normalization does not sort). Use platform Web Crypto (`crypto.subtle`).

- **Compatibility:** a continuation runs only if this request's freshly
  composed effective query matches the digest.
- **Not a secret:** anyone who can construct the same AST can compute the
  digest. Do not document the hash as confidential.
- **Not authenticated:** a client can forge `binding`, `id`, or `values`.
  Forging a digest for a *different* scope fails the compatibility check after
  reauthorization. Forging `id` / `values` under the *current* scope can skip
  or reorder pages **inside the authorized set**, the same class as unsigned
  v2/v3 cursors. The cursor is not an authorization credential.
- **Confidentiality of server predicates:** v4 omits the effective AST so a
  decoder does not see server-only leaves. That is **omission, not
  encryption**. Indexed `values` still expose the last returned row's index
  tuple, which may include owner fields already present in that page. Do not
  claim indexed cursors hide authorization data.

# Indexes, count, and tests

`planIndexRange` and SQL compilation consume the effective query so a scope
equality can be an index prefix. Count uses the same effective set as list
across pages.

Ship list, count, indexes, cursor v4, and security tests as **one
implementation unit**. Do not split the first landing by package or by
`list` vs `count`.

Update the owner-scoped recipe and README so member list uses `listWhere`
instead of requiring `queryImpliesEquality` on the client filter. Document
`queryImpliesEquality` as optional application proof, not the list mechanism.

# Package boundaries

| Package | Owns |
| --- | --- |
| `@takibi/policy` | Grant list-decision semantics, WeakMap storage, `and` / `or` exits, `listDecisionOf` |
| `@takibi/query` | `listWhere`, `composeAnd` / `composeOr` |
| `@takibi/protocol` | AST shape, client 32/8 limits, server 64/16 composition limits |
| `@takibi/shared-types` | `ListWhereScope`; optional `requestedWhere` on `StorageListOptions` |
| `@takibi/worker-runtime` | One-shot evaluate, requested vs effective, public and action facades |
| `@takibi/storage` | Effective-query execution, index planning, cursor v4 |
| `@takibi/api` / `takibi` | Re-exports and collection types; no new `listScope` field |

No new package. Policy does not depend on query. Cursor encoding stays in
storage.

# Out of scope

- Declarative predicates for `get` / write. Visibility of old vs new documents
  is not immutable owner enforcement and is a later design.
- Collection-level `listScope`.
- Moving cursors to protocol or treating a digest as a secret.
- Implementing watch, a reserved context identity, or a general JS-to-SQL
  compiler.
- Applying scope to trusted `$collections`.
- Raising client query limits or silently flattening trees.
