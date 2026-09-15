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
[0015-policy-owned-list-scope](../0015-policy-owned-list-scope/issue.md).

# Decision

List and count authorization is a **policy-owned range**, not a separate
collection ceiling.

A grant's list decision is exactly one of:

- `deny` — no `list` permission
- `allowAll` — unrestricted list (`grant("list")`, `read`, `fullAccess` today)
- `allowWhere(QueryExpr)` — list only rows matching a server-built query

Owner, admin, and public-record rules compose through existing `and` / `or`.
Do not add `listScope` to `CollectionDefinition`.

# Behavior before this issue

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
grant(
  "get",
  listWhere((q) => q.ownerId.eq(user.id)),
);
grant("list"); // allowAll
```

`listWhere` lives in `@takibi/query` and is `compileWhere` plus a brand: the
callback must return a builder-created `QueryExpr`, which is then normalized
under the existing 32/8 client limits. The token type lives in
`@takibi/shared-types` as the shared token contract. `@takibi/policy` depends on `@takibi/query`
for scope recognition and validated composition.

```ts
declare const listWhereScopeBrand: unique symbol;

type ListWhereScope = {
  readonly [listWhereScopeBrand]: true;
  readonly kind: "listWhere";
  readonly where: QueryExpr;
};
```

`grant(listWhere(...))` grants `list` as `allowWhere`. A bare `"list"` in the
same call as a scope token is invalid, so it cannot silently discard the scope.
`grant("list")` alone is `allowAll`; `allowAll` AND `allowWhere(W)` across
separate grants is `allowWhere(W)`. Two `listWhere` tokens in one `grant()` AND
together.

`read` and `fullAccess` stay `allowAll`. Constant `grant("get")` / `none` stay
`deny` for list. Unscoped `grant("list")` remains unrestricted.

Do not invent `grant.list.allowAll()` or a JS-to-SQL compiler. Field typing
uses `QueryBuilder<TDoc>`. Type tests must reject unknown fields; bind `TDoc`
from the collection schema (a schema-bound helper alias is allowed).

Export `listDecisionOf(grant)` from `@takibi/policy` for runtime. Store the
decision in a WeakMap beside permissions.

# Collection example

This example uses the implemented API.
Assume `z` is imported from `zod`, the policy helpers from `takibi`, and an
existing `context` resolves `user` as
`{ id: string; role: "admin" | "member" } | null`.

```ts
const postSchema = z.object({
  ownerId: z.string(),
  title: z.string(),
});

type Post = z.infer<typeof postSchema>;

const ownerReadPolicy = context.policy(postSchema, ({ user, operation, doc }) => {
  if (!user) return none;

  switch (operation) {
    case "list":
    case "count":
      return grant(listWhere<Post>((q) => q.ownerId.eq(user.id)));
    case "get":
      return doc?.ownerId === user.id ? grant("get") : none;
    default:
      return none;
  }
});

const adminReadPolicy = context.policy(({ user }) => (user?.role === "admin" ? read : none));

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

Permissions stay independent of list range. A branch granting `update` but
not `list` contributes no range to OR and denies list under AND, as in the table.

Conceptual operators on list decisions:

| left \ right     | `deny`                               | `allowAll`                               | `allowWhere(W2)`                                   |
| ---------------- | ------------------------------------ | ---------------------------------------- | -------------------------------------------------- |
| `deny`           | `deny`                               | `deny` (and) / `allowAll` (or)           | `deny` (and) / `allowWhere(W2)` (or)               |
| `allowAll`       | `deny` (and) / `allowAll` (or)       | `allowAll`                               | `allowWhere(W2)` (and) / `allowAll` (or)           |
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
[0007-realtime-query-watch](../../open/0007-realtime-query-watch/issue.md) must call
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
  Forging a digest for a _different_ scope fails the compatibility check after
  reauthorization. Forging `id` / `values` under the _current_ scope can skip
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

| Package                  | Owns                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `@takibi/policy`         | Grant list-decision semantics, WeakMap storage, `and` / `or` exits, `listDecisionOf` |
| `@takibi/query`          | `listWhere`, `composeAnd` / `composeOr`                                              |
| `@takibi/protocol`       | AST shape, client 32/8 limits, server 64/16 composition limits                       |
| `@takibi/shared-types`   | `ListWhereScope`; optional `requestedWhere` on `StorageListOptions`                  |
| `@takibi/worker-runtime` | One-shot evaluate, requested vs effective, public and action facades                 |
| `@takibi/storage`        | Effective-query execution, index planning, cursor v4                                 |
| `@takibi/api` / `takibi` | Re-exports and collection types; no new `listScope` field                            |

No new package. Policy depends on query for validated composition and token recognition. Cursor encoding stays in
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

# Approved implementation details (2026-09-15)

### Accepted API / package boundaries

`@takibi/policy` may depend on `@takibi/query`. Policy owns list-decision
semantics and grant metadata; query owns scope-token creation/recognition and
validated `composeAnd` / `composeOr`. Query depends on protocol and shared-types,
and must not depend on policy, API or runtime. Protocol owns AST normalization
and client/server budgets, not Boolean composition. No new package is added.

`ListWhereScope` remains a shared-types contract with readonly `kind` and
`where` plus an opaque type brand. Query registers frozen `listWhere` products
in a private WeakSet and exports `isListWhereScope` for policy. A structural
lookalike or cloned token is invalid. Grant's direct inputs and catalog callback
results accept the tokens. Tokens require the same query package instance.

`listDecisionOf` returns exactly `{ kind: "deny" }`, `{ kind: "allowAll" }`,
or `{ kind: "allowWhere", where: QueryExpr }`; where is already validated and
frozen. An unknown grant is a safe policy error, never unrestricted access.
No deferred plan or materialization callback is introduced.

### Composition

Multiple scope tokens in one grant form one n-ary AND in argument order.
A bare list permission together with any scope token is rejected. Token provenance
is checked even with bare list. Policy combinators use an ordered left fold;
three scoped AND branches therefore form `and(and(A,B),C)`. Do not flatten,
sort or reassociate. Decision identities follow the existing truth table.

Every eagerly constructed scoped expression must satisfy the server budget
before evaluation continues, even if a later branch would absorb its result.
Existing short circuits still skip unevaluated branches. Scoped grants with
every permission must not intern to fullAccess. Static-reason wrappers copy
the list decision as well as permissions and reasons.

### Capacity / failure handling

Keep client normalization and each listWhere leaf at 32 nodes/depth 8. Add a
separate protocol server-normalization entry point sharing the existing private
validator at 64 nodes/depth 16. Keep the in-value limit at 32. Query composes
ASTs through that server entry point, including validation of singleton inputs;
zero inputs are invalid. Two 32-node operands plus one wrapper exceed 64.

`listWhere` converts all callback and validation errors, including thrown public
error objects, to a static query-owned ListScopeError without raw values,
original messages or exposed causes. Token/composition failures use that error
too. Runtime maps scope failures at evaluation/composition boundaries to
INVALID_LIST_SCOPE, status 500, message "Invalid list authorization scope".
Permission denial remains FORBIDDEN. Module-initialization failure stops startup
with the sanitized local error. Unrelated policy-error handling is unchanged.

### Runtime / cursors

Resolve effective options once after one policy evaluation and before storage;
preserve request and AccessContext.where. Count reuses those options across its
internal pages, while every new external continuation reauthorizes.

Define `StorageListOptions.requestedWhere?: QueryExpr | null`: explicit null
means no client predicate; omission means trusted fallback to where. Runtime
always supplies the requested value or null for policy-bound list/count.
Public decoding must reject this server-only option as client input. Storage
validates effective where at 64/16, requested where at 32/8, before planning.
Effective validation failures are safe 500s; invalid requests/cursors remain
safe 400s. Trusted collections bypass policy and use requested = effective.

Cursor v4 and its security guarantees are unchanged. Digest input is the
ordered normalized AST specified above; semantically equivalent reassociation
is not cursor-compatible. No plan, scope AST or principal identity enters v4.
