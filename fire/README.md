# @takibi/fire

Typed, Firebase-like resource store for Cloudflare Durable Objects — with oRPC-style end-to-end types, tenant isolation, and access control.

## AuthN vs AuthZ

**AuthN** (who is calling, which tenant they may use) is owned by your application.
**AuthZ** (what that identity may do to a resource) is owned by `@takibi/fire`
via `accessControl`.

`createContext({ resolve })` is the trust boundary. Inside `resolve` you must:

1. Verify a credential, session, or trusted gateway assertion and set `user`
2. Decide the tenant for this request (from the identity claim and/or an
   application-approved selector)
3. Confirm the user may use that tenant, then return `{ tenantId, user, ... }`

Do **not** trust client-declared identity or tenant headers (for example
`x-user` / `x-tenant-id`). The library never parses those. Anonymous apps return
`user: null` explicitly from `resolve`. Public tenant selection is also a
`resolve` decision — empty `tenantId` is rejected with 401.

## Server

```ts
import { ALL, EDIT, READ, UnauthorizedError, createContext } from "@takibi/fire";
import { Hono } from "hono";
import { z } from "zod";

type User = { id: string; role: "admin" | "member"; tenantIds: string[] };

async function authenticate(request: Request): Promise<User | null> {
  // Verify Bearer / Cookie / Access JWT / etc. — your choice of library & IdP.
  // Return null for anonymous access when your app allows it.
  void request;
  return null;
}

const context = createContext<{ tenantId: string; user: User | null }>({
  resolve: async ({ request }) => {
    const user = await authenticate(request);
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
});

const handler = context.resources({
  posts: {
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    accessControl({ user }) {
      if (user?.role === "admin") return ALL;
      if (user) return [READ, EDIT];
      return READ;
    },
  },
});

export type Handler = typeof handler;
export class TenantStore extends handler.DurableObject {}

const app = new Hono<{ Bindings: { TENANT_STORE: DurableObjectNamespace } }>();
app.route("/foo", handler);
export default app;
```

Prefer throwing `UnauthorizedError` (or returning only after membership checks) from
`resolve` when AuthN / tenant membership fails. The library also rejects an empty
`tenantId` after `resolve` returns.

## Client

Carry credentials your server trusts — not self-declared role or membership JSON.

```ts
import { createClient } from "@takibi/fire";
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

All `CollectionApi` methods return `Promise<FireResult<T>>`.
Server-decided failures (`NOT_FOUND`, `FORBIDDEN`, `VALIDATION`, `ALREADY_EXISTS`, …)
resolve as `{ ok: false, error }` — they do **not** reject.

Transport / protocol problems still reject the Promise (fetch failure, abort, invalid
JSON, invalid response envelope). Use `try/catch` only for those.

Document `id` is not part of the resource schema. Pass domain fields only in `data`;
use `add(data, { id })` when you need a caller-chosen id. `add` fails with
`ALREADY_EXISTS` (409) if that id already exists — use `set(id, data)` to upsert.

### Migrating from the previous throw / null API

```ts
// Before
const post = await client.posts.get(id); // null when missing
try {
  await client.posts.update(id, patch);
} catch (err) {
  if (err instanceof FireError && err.code === "NOT_FOUND") {
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

### Migrating `createContext` to `{ resolve }`

Removed: function shorthand, `AuthBits`, `getTenantId`, `getUser`, `context`, and any
default parsers for `x-user` / `x-tenant-id`.

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
createContext({
  resolve: async ({ request }) => {
    const user = await authenticate(request);
    const tenantId = await authorizeTenant(request, user);
    return { tenantId, user };
  },
});
```

## Durable Object storage

Inside the DO (trusted / admin path, ACL bypassed):

```ts
const result = await this.storage.posts.add({ title: "Hi", body: "..." });
if (result.ok) {
  // result.data
}
```

In memory mode (`{ memory: true }`), the same Result-shaped API is on `handler.storage`.
Documents are stored with the Durable Object Storage KV API
(`get` / `put` / `delete` / `list`) under keys `fire:${resource}:${id}`.
One document is one entry. The library does **not** use `state.storage.sql` or
manage application SQL schemas / migrations.

Auto-generated document ids are monotonic ULIDs (26 Crockford Base32 characters).
Caller-supplied ids are still accepted; creation-order lexicographic sort is
guaranteed only for library-generated ULIDs.

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
- Do not create new Legacy KV-backed classes for `@takibi/fire`.

## Limits and layout

| Backend                                     | Per-entry size         |
| ------------------------------------------- | ---------------------- |
| SQLite-backed DO (required for new classes) | key + value ≤ **2 MB** |
| Legacy KV-backed DO                         | value ≤ **128 KiB**    |

- `get` / `update` / `list` always read or write the **whole** document value.
  There is no field projection or partial array read.
- Growing collections belong in child resources (for example `postItems` with a
  parent id field), not as unbounded arrays embedded in a parent document.
  Keep embedded arrays small and bounded.
- `list` returns full documents, paged with `{ limit?, cursor? }` over id order
  (prefix + `startAfter`). It does not offer `where` / `orderBy` / offset.
