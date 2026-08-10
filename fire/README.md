# @takibi/fire

Typed, Firebase-like resource store for Cloudflare Durable Objects — with oRPC-style end-to-end types, tenant isolation, and access control.

## Server

```ts
import { ALL, EDIT, READ, createContext } from "@takibi/fire";
import { Hono } from "hono";
import { z } from "zod";

type User = { id: string; role: "admin" | "member" };

const context = createContext<{ tenantId: string; user: User | null }>(({ tenantId, user }) => ({
  tenantId,
  user: user as User | null,
}));

const handler = context.resources({
  posts: {
    schema: z.object({
      id: z.string().optional(),
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

Default auth extraction:

- tenant: `x-tenant-id` header
- user: `x-user` JSON header (override with `getUser` / `resolve`)

## Client

```ts
import { createClient } from "@takibi/fire";
import type { Handler } from "./server";

const client = createClient<Handler>("https://localhost:3000/foo", {
  headers: () => ({
    "x-tenant-id": "acme",
    "x-user": JSON.stringify({ id: "u1", role: "member" }),
  }),
});

await client.posts.add({ title: "Hi", body: "..." });
```

## Durable Object storage

Inside the DO (trusted / admin path, ACL bypassed):

```ts
// this.storage.posts.add({ ... })
```

In memory mode (`{ memory: true }`), the same API is on `handler.storage`.

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

- Bind one DO per tenant (`idFromName(tenantId)`).
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
