# @takibi/takibi

Typed multi-tenant collection store on Cloudflare Durable Objects — with end-to-end types from `typeof handler` to `createClient`, REST-shaped HTTP, tenant isolation, and access control.

The official public API is `createTakibi`, `createClient`, policy helpers, and errors. Lower-level assembly pieces are unpublished.

## AuthN vs AuthZ

**AuthN** (who is calling, which tenant they may use) is owned by your application.
**AuthZ** (what that identity may do to a collection) is owned by `@takibi/takibi`
via `accessPolicy`.

`createTakibi()({ resolve })` is the trust boundary. Inside `resolve` you must:

1. Verify a credential, session, or trusted gateway assertion and set `user`
2. Decide the tenant for this request (from the identity claim and/or an
   application-approved selector)
3. Confirm the user may use that tenant, then return `{ tenantId, user, ... }`

Do **not** trust client-declared identity or tenant headers (for example
`x-user` / `x-tenant-id`). The library never parses those. Anonymous apps return
`user: null` explicitly from `resolve`. Public tenant selection is also a
`resolve` decision — empty `tenantId` is rejected with 401.

## Server

Prefer oRPC-style [initial context](https://orpc.dev/docs/context): put framework
deps (`di`, `env`, …) on `handle(..., { context })`. Bind them with
`createTakibi<Initial>()`, then call the returned factory with `{ resolve, stub? }`.
`TCtx` is inferred from `resolve`'s return (annotate with `Promise<AppCtx>` when
you want a named / wider type). `stub` receives the same input plus `tenantId`
and returns a Durable Object stub — no library-side `env` / `bindings` option.
Empty initial uses `createTakibi()` (no type argument).

```ts
import { UnauthorizedError, createTakibi, fullAccess, grant, read } from "@takibi/takibi";
import { Hono } from "hono";
import { z } from "zod";

type User = { id: string; role: "admin" | "member"; tenantIds: string[] };
type Initial = {
  di: { getSession(request: Request): Promise<User | null> };
  env: { TENANT_STORE: DurableObjectNamespace };
};
type AppCtx = { tenantId: string; user: User | null };

const takibi = createTakibi<Initial>()({
  resolve: async ({ request, context }): Promise<AppCtx> => {
    const user = await context.di.getSession(request);
    const requested = request.headers.get("x-tenant-id"); // optional hint only
    const tenantId =
      (user && requested && user.tenantIds.includes(requested) ? requested : null) ??
      user?.tenantIds[0] ??
      null;
    if (!tenantId) {
      throw new UnauthorizedError("Unknown tenant");
    }
    return { tenantId, user };
  },
  stub: ({ context, tenantId }) => {
    const ns = context.env.TENANT_STORE;
    return ns.get(ns.idFromName(tenantId));
  },
});

const memberAccess = grant("create", "get", "list", "update", "delete");
const handler = takibi.collections({
  posts: {
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    accessPolicy({ user }) {
      if (user?.role === "admin") return fullAccess;
      if (user != null) return memberAccess;
      return read;
    },
  },
});

export type Handler = typeof handler;
export class TenantStore extends handler.DurableObject {}

const app = new Hono<{ Bindings: { TENANT_STORE: DurableObjectNamespace } }>();
app.all("/foo/*", async (c) => {
  const { matched, response } = await handler.handle(c.req.raw, {
    prefix: "/foo",
    context: {
      di: c.get("di"),
      env: c.env,
    },
  });
  if (matched) return response;
  return c.notFound();
});
export default app;
```

When initial context is empty and you use `{ memory: true }`, you can still mount
with `app.route("/foo", handler)` for simple demos and tests. Durable Object mode
always needs `stub` (and usually `handle` so AuthN / env reach `resolve` / `stub`).

### Collection seeds

Use `seed` for production defaults. It returns schema inputs keyed by document
ID, so IDs do not need to be repeated inside document data:

```ts
const handler = context.collections({
  settings: {
    schema: z.object({
      bookingUrl: z.string(),
    }),
    accessPolicy: fullAccess,
    seed: () => ({
      default: {
        bookingUrl: "",
      },
    }),
  },
});
```

Seeds run before the Durable Object accepts requests and before memory-mode
storage operations. They are create-only: an existing document is never
overwritten, including when a Durable Object is reactivated. Adding another ID
to the returned record creates that default on the next activation. Seed values
are validated by the collection schema and bypass `accessPolicy`, like trusted
`$collections` operations.

`accessPolicy` receives `doc` / `nextDoc` (schema output plus `id` / `createdAt` / `updatedAt`) so you can authorize on document attributes — not only collection-level actions:

| operation | `doc`                               | `nextDoc`                    |
| --------- | ----------------------------------- | ---------------------------- |
| add       | —                                   | validated create candidate   |
| get       | saved value                         | —                            |
| list      | —                                   | —                            |
| update    | saved value                         | merge + validation candidate |
| delete    | saved value                         | —                            |
| set       | saved value if present, else absent | validated replace candidate  |

Missing get / update / delete never call `accessPolicy` (`NOT_FOUND`). Denying an **existing** document (get / update / delete / existing set) also returns `NOT_FOUND` so IDs are not leaked. Denying create / new set / list returns `FORBIDDEN`.

### Grants: `fullAccess` / `write` / `read` / `none` / `grant(...)`

`accessPolicy` returns an **`AccessGrant`** — the set of permissions the subject may perform on this collection / document — not a yes/no for the current request. The executor allows the call when the grant contains `permission` (`create` / `get` / `list` / `update` / `delete`).

| helper                   | permissions                               |
| ------------------------ | ----------------------------------------- |
| `fullAccess`             | create, get, list, update, delete, invoke |
| `write`                  | create, update, delete                    |
| `read`                   | get, list                                 |
| `none`                   | (empty)                                   |
| `grant("create", "get")` | the permissions you list                  |

A constant grant is valid (`accessPolicy: write`). Combine `or(read, write)` for
CRUD without action invocation, and use `fullAccess` when `invoke` is also
intended. Prefer returning a grant without switching on `permission`;
`permission` stays on the context for logging and policies that need to
distinguish list from get.

### Typed policies with `context.policy`

`context.policy` is identity at runtime. It exists so reusable `accessPolicy` functions keep `user` from `resolve` and, when you pass a schema, type `doc` / `nextDoc` inside the callback. Pass the collection schema or a pick of its fields. A pick-schema policy assigns to a collection iff those keys exist on the document (optional vs required does not matter). `and` / `or` infer that pick from their arguments.

`and` intersects grants; `or` unions them. Import the root functions. Identity
rules and document rules compose:

```ts
import { and, fullAccess, none, read } from "@takibi/takibi";

const staffPolicy = context.policy(({ user }) => (user != null ? fullAccess : none));
const isSeededData = context.policy(itemSchema, ({ doc, nextDoc }) =>
  doc?.isSeeded || nextDoc?.isSeeded ? read : fullAccess,
);

const handler = context.collections({
  items: {
    schema: itemSchema,
    accessPolicy: and(staffPolicy, isSeededData),
  },
});
```

Staff can read and write unseeded documents and invoke actions; seeded documents
stay readable. `and(staffPolicy, read)` is the same pattern with a constant
grant.

### Owner-scoped collections

Ownership is domain-specific policy rather than library metadata. See the
[owner-scoped collection policy recipe](./docs/recipes/owner-scoped-collections.md)
for an application-local policy that prevents owner reassignment and only
grants member lists when the query guarantees the caller's owner value. The
policy must prove the whole expression, not merely find an owner leaf that
could be bypassed by `or` or `not`:

```ts
import { grant, none, queryImpliesEquality } from "@takibi/takibi";

accessPolicy({ user, operation, where }) {
  if (
    operation === "list" &&
    user &&
    queryImpliesEquality(where, "ownerId", user.id)
  ) {
    return grant("list");
  }
  return none;
}
```

Prefer throwing `UnauthorizedError` (or returning only after membership checks) from
`resolve` when AuthN / tenant membership fails. The library also rejects an empty
`tenantId` after `resolve` returns.

### Actions

Use actions for named server-side work that CRUD cannot express. Collection
actions are declared with `defineCollection`; root actions are built from the
assembled handler and registered with `.actions()`.

```ts
const posts = context.defineCollection({
  schema: postSchema,
  accessPolicy: postPolicy,
  actions: (defineAction) => ({
    duplicate: defineAction()
      .input(z.object({ id: z.string(), title: z.string() }))
      .policy(staffPolicy)
      .handler(async ({ input, collection, $collection }) => {
        const source = await $collection.get(input.id);
        const { id: _id, createdAt: _c, updatedAt: _u, ...fields } = source;
        return collection.add({ ...fields, title: input.title });
      }),
    stats: defineAction()
      .requires("list")
      .policy(staffPolicy)
      .handler(async ({ collection }) => {
        const page = await collection.list();
        return { count: page.items.length };
      }),
  }),
});

const base = context.collections({ posts });
const exportAll = base
  .defineAction()
  .policy(staffPolicy)
  .handler(async ({ collections }) => ({
    posts: (await collections.posts.list()).items,
  }));
const handler = base.actions({ exportAll });
```

`.input(...)` takes a Standard Schema, including refinements. Input failures
become `{ kind: "validation", code: "VALIDATION" }` with field `issues`. Throw a
`TakibiError` subclass from the handler for operation failures.

Every action has a mandatory gate policy. Normal `collection` / `collections`
CRUD evaluates each collection's `accessPolicy`; `$collection` /
`$collections` bypasses only that document policy and never bypasses the action
gate. These server-side facades throw `TakibiError` on failure.

The public client is flat:

```ts
await client.posts.duplicate({ id: "p1", title: "Copy" });
await client.posts.stats();
await client.exportAll();
```

Actions use `POST {baseUrl}/{collection}:{name}` and root actions use
`POST {baseUrl}/$:{name}`. Query parameters are rejected. Input is validated
with Standard Schema; omitted input remains `undefined`, while JSON `null`
remains explicit. Outputs must be JSON-safe; `void` becomes `data: null`.

## Client

`createClient<typeof handler>(baseUrl)` infers the collection and action maps from the handler
type. Transport is REST-shaped HTTP; the oRPC-style part is that type inference,
not an RPC wire.

| operation | HTTP                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| `add`     | `POST {baseUrl}/{collection}` — caller-chosen id: `POST {baseUrl}/{collection}/{id}` |
| `set`     | `PUT {baseUrl}/{collection}/{id}`                                                    |
| `get`     | `GET {baseUrl}/{collection}/{id}`                                                    |
| `update`  | `PATCH {baseUrl}/{collection}/{id}`                                                  |
| `delete`  | `DELETE {baseUrl}/{collection}/{id}`                                                 |
| `list`    | `GET {baseUrl}/{collection}?limit=&cursor=&where=`                                   |

`POST` / `PUT` / `PATCH` bodies are the document input (not an internal wire request).
`GET` / `DELETE` have no body. Worker→Durable Object forwarding stays an internal
JSON POST and is not part of the public HTTP contract.

Success and failure use the envelope `{ ok: true, data }` / `{ ok: false, error }`.
HTTP status matches `error.status` on failure (200 on success). This envelope is
the public HTTP response contract.

Carry credentials your server trusts — not self-declared role or membership JSON.

```ts
import { createClient } from "@takibi/takibi";
import type { Handler } from "./server";

const client = createClient<Handler>("https://localhost:3000/foo", {
  headers: () => ({
    Authorization: `Bearer ${getAccessToken()}`,
    // Optional routing hint; the server must authorize it inside resolve.
    "x-tenant-id": "acme",
  }),
});

const created = await client.posts.add({ title: "Hi", body: "..." });
// Or pick the document id yourself:
// const created = await client.posts.add({ title: "Hi", body: "..." }, { id: "post-1" });
if (!created.ok) {
  if (created.error.kind === "validation") {
    // Field errors for forms: message + path only
    for (const issue of created.error.issues) {
      console.error(issue.path?.join("."), issue.message);
    }
  } else if (created.error.code === "ALREADY_EXISTS") {
    // add is create-only; use set(id, data) to upsert
    console.error(created.error.message);
  } else {
    console.error(created.error.code, created.error.message);
  }
  return;
}

const post = created.data;
```

All public client collection methods return `Promise<TakibiResult<T>>`.
Server-decided failures (`NOT_FOUND`, `FORBIDDEN`, `VALIDATION`, `ALREADY_EXISTS`, …)
resolve as `{ ok: false, error }` — they do **not** reject.

Transport / protocol problems still reject the Promise (fetch failure, abort, invalid
JSON, invalid response envelope). Use `try/catch` only for those.

Document `id` is not part of the collection schema. Pass domain fields only in `data`;
use `add(data, { id })` when you need a caller-chosen id. `add` fails with
`ALREADY_EXISTS` (409) if that id already exists — use `set(id, data)` to upsert.

Every saved document also carries server-managed `createdAt` / `updatedAt` (UTC ISO 8601
via `Date.prototype.toISOString()`, e.g. `2026-08-09T14:12:00.000Z`). Do not define those
fields in the collection schema and do not send them from the client — both input own
properties and schema transforms that emit them fail validation. `add` and create-via-`set`
set both timestamps to the same write-time value; overwrite `set` / `update` keep
`createdAt` and refresh `updatedAt`. Empty patches and same-value writes still bump
`updatedAt`. These timestamps are observational only — not revisions, ETags, or optimistic
lock tokens. Same-millisecond writes may share a value.

### List queries

`list.where` is a typed AST builder callback, not a JavaScript predicate over
documents. It runs synchronously once in the client or server facade and sends
only the normalized expression to the server:

```ts
const page = await client.posts.list({
  where: (query) => query.and(query.ownerId.eq(currentUser.id), query.createdAt.gte(yesterday)),
  limit: 50,
});
```

Top-level scalar fields support `eq`; string and number fields also support
`gt`, `gte`, `lt`, and `lte`. Compose expressions with `and`, `or`, and `not`.
Results are always ordered by document id, and filtering happens before
`cursor` and `limit`.

The initial memory and Durable Object implementations have no field indexes:
each query reads and filters the whole collection inside the trusted server.
This is a linear scan, but non-matching documents are never included in the
HTTP response. Treat `nextCursor` as opaque and reuse it only with the same
collection and structurally identical query; do not inspect, modify, or guess
cursor values.

### Migrating from the previous throw / null API

```ts
// Before
const post = await client.posts.get(id); // null when missing
try {
  await client.posts.update(id, patch);
} catch (err) {
  if (err instanceof TakibiError && err.code === "NOT_FOUND") {
    /* ... */
  }
}

// After
const result = await client.posts.get(id);
if (!result.ok) {
  if (result.error.code === "NOT_FOUND") {
    /* ... */
  }
  return;
}
const post = result.data;
```

`get` / `update` / `delete` use the same `NOT_FOUND` failure when the document is missing.
`set` remains upsert and succeeds for a new id.

### Migrating to `createTakibi`

Removed: the `createContext` shortcut, function shorthand, `AuthBits`, `getTenantId`,
`getUser`, `context`, and any default parsers for `x-user` / `x-tenant-id`.

```ts
// Before (trusted client-declared headers — do not keep this)
createContext(({ tenantId, user }) => ({ tenantId, user }));

createContext({
  getUser: async (request) => {
    /* ... */
  },
  context: ({ tenantId, user }) => ({ tenantId, user }),
});

// After — one trust boundary for AuthN + tenant membership
createTakibi()({
  resolve: async ({ request }) => {
    const user = await authenticate(request);
    const tenantId = await authorizeTenant(request, user);
    return { tenantId, user };
  },
});
```

## Durable Object collections

Inside the DO (trusted / admin path, `accessPolicy` bypassed):

```ts
const post = await this.$collections.posts.add({ title: "Hi", body: "..." });
```

Documents are stored with the Durable Object Storage KV API
(`get` / `put` / `delete` / `list`) under internal collection-prefixed keys.
One document is one entry. The library does **not** use `state.storage.sql` or
manage application SQL schemas / migrations.

Auto-generated document ids are monotonic ULIDs (26 Crockford Base32 characters).
Caller-supplied ids are still accepted; creation-order lexicographic sort is
guaranteed only for library-generated ULIDs.

**Breaking change — document timestamps:** stored documents now require `createdAt` /
`updatedAt`. Existing PoC namespaces / fixtures without those fields must be cleared and
recreated. Environments that must keep data need a one-off migration that sets both fields
to the migration time before deploy; this package does not ship a migration tool.

## Wrangler

Register a **new** Durable Object class with SQLite storage. Backend choice is
fixed when the class namespace is created.

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "TENANT_STORE", "class_name": "TenantStore" }],
  },
  "exports": {
    "TenantStore": {
      "type": "durable-object",
      "storage": "sqlite",
    },
  },
}
```

Legacy Workers that still use the `migrations` array can create a SQLite-backed
class with `new_sqlite_classes` instead of `exports`. Prefer `exports` for new
projects.

Notes:

- Bind one DO per tenant (`idFromName(tenantId)` from `resolve`).
- Existing Legacy KV-backed namespaces **cannot** be converted in place to
  SQLite. Move data to a new SQLite-backed class / namespace separately.
- Do not create new Legacy KV-backed classes for `@takibi/takibi`.

## Limits and layout

| Backend                                     | Per-entry size         |
| ------------------------------------------- | ---------------------- |
| SQLite-backed DO (required for new classes) | key + value ≤ **2 MB** |
| Legacy KV-backed DO                         | value ≤ **128 KiB**    |

- `get` / `update` / `list` always read or write the **whole** document value.
  There is no field projection or partial array read.
- Growing collections belong in child collections (for example `postItems` with a
  parent id field), not as unbounded arrays embedded in a parent document.
  Keep embedded arrays small and bounded.
- `list` returns full documents in id order and supports typed `where`,
  `limit`, and an opaque query-bound `cursor`. It does not offer `orderBy`,
  offset, or projection.
- `where` is currently an unindexed server-side linear scan. Non-matching
  documents remain inside the trusted storage boundary and are not returned to
  the client.
