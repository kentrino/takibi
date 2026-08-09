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

## Wrangler

Bind one DO per tenant (`idFromName(tenantId)`):

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "TENANT_STORE", "class_name": "TenantStore" }],
  },
}
```
