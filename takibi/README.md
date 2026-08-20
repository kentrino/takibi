# @takibi/takibi

Typed multi-tenant collection store on Cloudflare Durable Objects — with end-to-end types from `typeof handler` to `createClient`, REST-shaped HTTP, tenant isolation, and access control.

The official public API is `createTakibi`, policy helpers, and errors on
`@takibi/takibi` and `createClient` on `@takibi/takibi/client`.
OpenTelemetry support is distributed separately as
`@takibi/takibi-opentelemetry`.

## AuthN vs AuthZ

**AuthN** (who is calling, which tenant they may use) is owned by your application.
**AuthZ** (what that identity may do to a collection) is owned by `@takibi/takibi`
via `accessPolicy`.

`createTakibi()({ resolve })` is the trust boundary. Inside `resolve` you must:

1. Verify a credential, session, or trusted gateway assertion
2. Decide the storage partition for this request (from the identity claim and/or an
   application-approved selector)
3. Confirm the caller may use that partition, then return your application context

Do **not** trust client-declared identity or tenant headers (for example
`x-user` / `x-tenant-id`). The library never parses those and does not reserve
`tenantId`, `user`, or any other execution-context key. Throw
`UnauthorizedError` from `resolve` when authentication or partition selection
fails.

Identity is whatever `resolve` returns. The Durable Object does not re-resolve
or re-verify the caller. Its `fetch` is only for the same Worker's `stub`
call; do not expose that class on a public route.

Named objects must use `idFromName(resolved.tenantId)` with that exact string
(no prefix). `fetch` compares `state.id.name` to `context.tenantId` and
rejects a mismatch with `ForbiddenError` (403). Objects created without a
name (`idFromString` and similar) skip that check.

## Server

Prefer oRPC-style [initial context](https://orpc.dev/docs/context): put framework
deps (`di`, `env`, …) on `handle(..., { context })`. Bind them with
`createTakibi<Initial>()`, then call the returned factory with `{ resolve, stub? }`.
`TCtx` is inferred from `resolve`'s return (annotate with `Promise<AppCtx>` when
you want a named / wider type). `stub` receives the same input plus the complete
application-owned context as `resolved` and returns a Durable Object stub — no
library-side `env` / `bindings` option.
Empty initial uses `createTakibi()` (no type argument).

```ts
import { UnauthorizedError, createTakibi, fullAccess, grant, read } from "@takibi/takibi";
import { Hono } from "hono";
import { z } from "zod";

type User = { id: string; role: "admin" | "member"; clinicIds: string[] };
type Initial = {
  di: { getSession(request: Request): Promise<User | null> };
  env: { TENANT_STORE: DurableObjectNamespace };
};
type AppCtx = { tenantId: string; principal: User | null };

const takibi = createTakibi<Initial>()({
  resolve: async ({ request, context }): Promise<AppCtx> => {
    const user = await context.di.getSession(request);
    const requested = request.headers.get("x-clinic-id"); // optional hint only
    const tenantId =
      (user && requested && user.clinicIds.includes(requested) ? requested : null) ??
      user?.clinicIds[0] ??
      null;
    if (!tenantId) {
      throw new UnauthorizedError("Unknown tenant");
    }
    return { tenantId, principal: user };
  },
  stub: ({ context, resolved }) => {
    const ns = context.env.TENANT_STORE;
    return ns.get(ns.idFromName(resolved.tenantId));
  },
});

const memberAccess = grant("create", "get", "list", "update", "delete");
const handler = takibi.collections({
  posts: {
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    accessPolicy({ principal }) {
      if (principal?.role === "admin") return fullAccess;
      if (principal != null) return memberAccess;
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

To exercise a production handler in tests, fork storage and AuthN with
`.with({ memory: true, resolve })`. Collection maps, collection actions, and
root actions stay the same references; each call gets its own memory store.

```ts
import { createClient } from "@takibi/takibi/client";

const handler = takibiHandler.with({
  memory: true,
  resolve: ({ request }) => {
    const raw = request.headers.get("x-test-user");
    const user = raw == null ? null : JSON.parse(raw);
    if (user == null) throw new UnauthorizedError("Sign in required");
    return { tenantId: "test", principal: user };
  },
});
const client = createClient<typeof takibiHandler>("https://fire.test", {
  fetch: handler.request,
  headers: { "x-test-user": JSON.stringify({ id: "u1", role: "member" }) },
});
```

`.with({ memory: true })` keeps the production `resolve`. Use that when tests
call `handle(request, { context })` with a fake session. `handler.request` has
an empty initial context, so apps whose production `resolve` needs session
deps should pass a test `resolve`.

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

### Lazy document migrations

Use `migrations` when a collection schema changes incompatibly. Each step
converts one stored document version to the next; a document is migrated on
access before it reaches `accessPolicy`, action code, query filtering, or a
write merge:

```ts
type SettingsV0 = { bookingUrl: string };

const handler = context.collections({
  settings: {
    schema: z.object({
      bookingUrl: z.string(),
      reminders: z.boolean(),
    }),
    migrations: {
      // Omit base for 0. The current version is base + steps.length.
      base: 0,
      steps: [
        (data) => ({
          ...(data as SettingsV0),
          reminders: true,
        }),
      ],
    },
    accessPolicy: fullAccess,
  },
});
```

Documents written by the current definition carry a private library version
marker. Existing documents without one are version `0`. The marker is not part
of schema input or output, policies, client responses, or `where` queries.

Treat `steps` as append-only. To retire old steps, remove them and raise `base`
to the oldest version still accepted; accessing an older document then fails.
A thrown step or current-schema validation failure leaves the original document
and marker unchanged, so the next access retries the migration. Steps are
synchronous and receive only unvalidated domain data—never `id`, timestamps, or
the version marker.

Migration is per-document and lazy. Takibi does not enumerate tenants, eagerly
migrate a whole deployment, report global progress, provide rollback or backup
tooling, or guarantee when inactive tenants finish migrating.

`accessPolicy` receives `doc` / `nextDoc` (schema output plus `id` / `createdAt` / `updatedAt`) so you can authorize on document attributes — not only collection-level actions:

| operation | `doc`                               | `nextDoc`                    |
| --------- | ----------------------------------- | ---------------------------- |
| add       | —                                   | validated create candidate   |
| get       | saved value                         | —                            |
| list      | —                                   | —                            |
| update    | saved value                         | merge + validation candidate |
| delete    | saved value                         | —                            |
| set       | saved value if present, else absent | validated replace candidate  |

Missing get / update / delete never call `accessPolicy` (`NOT_FOUND`). Denying get / update / delete / **set** also returns `NOT_FOUND` so IDs are not leaked — `set` uses the same code for a new id and an existing id. Denying create (`add`) / list returns `FORBIDDEN`.

### Grants: `fullAccess` / `write` / `read` / `none` / `grant(...)`

`accessPolicy` returns an **`AccessGrant`** — an opaque value for the permissions the subject may perform on this collection / document — not a yes/no for the current request. Build a grant with `grant(...)` or a predefined grant (`fullAccess` / `write` / `read` / `none`) and return it from the policy. The executor allows the call when that grant includes the required `permission` (`create` / `get` / `list` / `update` / `delete`).

| helper                            | permissions                               |
| --------------------------------- | ----------------------------------------- |
| `fullAccess`                      | create, get, list, update, delete, invoke |
| `write`                           | create, update, delete                    |
| `read`                            | get, list                                 |
| `none`                            | (empty)                                   |
| `grant("create", "get")`          | the permissions you list                  |
| `grant((g) => [g.create, g.get])` | the same grant, via catalog properties    |

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

Throw `UnauthorizedError` (or return only after membership checks) from `resolve`
when AuthN or storage-partition authorization fails. Takibi validates that the
resolved context is a JSON-safe object but does not interpret its keys.

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

Every action has a mandatory gate policy. Collection `defineAction().policy()`
accepts the same schema-bound policy as that collection's `accessPolicy`; the
gate evaluates it without a target `doc` (the same shape as `list` / `add`).
Root actions have no collection schema, so they still take a grant, a
context-only policy, or an `ActionGateContext` callback. Normal
`collection` / `collections` CRUD evaluates each collection's `accessPolicy`;
`$collection` / `$collections` bypasses only that document policy and never
bypasses the action gate. These server-side facades throw `TakibiError` on
failure.

Add `.atomic()` before `.handler()` when all Takibi collection storage
operations in an action must commit or roll back together:

```ts
const placeOrder = base
  .defineAction()
  .input(placeOrderSchema)
  .atomic()
  .policy(staffPolicy)
  .handler(async ({ input, $collections }) => {
    const order = await $collections.orders.add(input.order);
    await $collections.inventory.update(input.itemId, { stock: input.stock });
    await $collections.events.add({ orderId: order.id });
    return order;
  });
```

The action gate and input validation run before the transaction. The handler,
collection schema validation and storage operations, `void`-to-`null`
normalization, and JSON output validation run inside it; they commit only when
all succeed. Any thrown failure rolls back writes already completed by that
atomic action. Actions without `.atomic()` keep the normal per-operation
behavior, so an earlier write remains after a later failure.

Atomic actions cover only operations performed through Takibi's
`collection(s)` / `$collection(s)` facades. HTTP requests, email, queue
publishes, and other external side effects cannot be rolled back, even when
they occur inside an atomic handler. Split those effects into a separate action
or use an application-level delivery pattern when they must be coordinated.

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
import { createClient } from "@takibi/takibi/client";
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

Collection schema outputs must be plain JSON objects. Nested plain objects, arrays,
strings, finite numbers, booleans, `null`, and absent optional fields round-trip
without conversion. `undefined`, non-finite numbers, `bigint`, symbols, accessors,
cycles, sparse/custom arrays, and objects such as `Date` are rejected before the
storage write with `INVALID_DOCUMENT`. Schemas whose output type is visibly not a
JSON object are rejected by `defineCollection`; transforms with an `unknown` output
are checked at runtime.

Every saved document also carries server-managed `createdAt` / `updatedAt` (UTC ISO 8601
via `Date.prototype.toISOString()`, e.g. `2026-08-09T14:12:00.000Z`). Do not define those
fields — or reserved `id`, `$schemaVersion`, and `rev` — in the collection schema, and do
not send them from the client. `defineCollection` rejects those keys at the type level;
both input own properties and schema transforms that emit them fail validation. `add` and create-via-`set`
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

The memory implementation evaluates the AST in JavaScript. The Durable Object
implementation compiles it to a parameterized SQLite predicate and performs a final
JavaScript check to preserve the same missing / null / type and string-ordering
semantics. There are no secondary field indexes yet, so SQLite may still scan the
collection, but non-matching current-version rows are not deserialized into JavaScript.
Treat `nextCursor` as opaque and reuse it only with the same collection and
structurally identical query; do not inspect, modify, or guess cursor values.

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

// After — one trust boundary for AuthN + partition membership
createTakibi()({
  resolve: async ({ request }) => {
    const user = await authenticate(request);
    const tenantId = await authorizeClinic(request, user);
    return { tenantId, principal: user };
  },
});
```

## Durable Object collections

Inside the DO (trusted / admin path, `accessPolicy` bypassed):

```ts
const post = await this.$collections.posts.add({ title: "Hi", body: "..." });
```

Documents are stored with `state.storage.sql` in one library-managed
`takibi_documents` table shared by all collections in the Durable Object. Domain
fields are JSON text; collection, id, timestamps, and document schema version are
separate columns. Takibi does not create a table or columns from each application
schema, and applications do not manage or query this internal table.

Auto-generated document ids are monotonic ULIDs (26 Crockford Base32 characters).
Caller-supplied ids are still accepted; creation-order lexicographic sort is
guaranteed only for library-generated ULIDs.

Takibi versions its internal SQL layout in `takibi_metadata` and migrates known
layout versions synchronously during activation. A newer unknown layout fails closed.
This internal layout migration is separate from collection `migrations`: layout
migrations change Takibi's tables, while collection migrations lazily transform one
domain document after it is read.

## Wrangler

Register a Durable Object class with SQLite storage:

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

Notes:

- Bind one DO per tenant with `idFromName(resolved.tenantId)` inside `stub`.
  The object name is that `tenantId`; prefixed names are not supported.
  `fetch` on the class is stub-only — do not route public HTTP to it.
- The root `@takibi/takibi` import does not require `nodejs_als`,
  `nodejs_compat`, or a minimum compatibility date.

## Observability

Install `@takibi/takibi-opentelemetry` to enable OpenTelemetry spans for
`resolve`, Worker → Durable Object wire, executor, policy, schema, storage, and
actions. The integration package owns its OpenTelemetry peer dependency,
runtime adapter, setup documentation, and tests; the core package has no
OpenTelemetry dependency. See that package's README for provider, context
manager, and flushing setup.

`takibi.wire` is a transport span. It covers the Durable Object fetch, full
response-body read, JSON decoding, and wire-envelope validation. Fetch or body
failures and malformed responses mark it as an error. A valid `{ ok: false }`
envelope, including one received with a non-2xx status, is a successfully
received remote-operation result and leaves the wire span successful; the
Durable Object's executor, policy, schema, storage, or action span records that
operation failure.

## Limits and layout

- Each stored document is limited to **2 MB**.

- `get` / `update` / `list` always read or write the **whole** document value.
  There is no field projection or partial array read.
- Growing collections belong in child collections (for example `postItems` with a
  parent id field), not as unbounded arrays embedded in a parent document.
  Keep embedded arrays small and bounded.
- `list` returns full documents in id order and supports typed `where`,
  `limit`, and an opaque query-bound `cursor`. It does not offer `orderBy`,
  offset, or projection.
- `where` is currently unindexed. SQLite evaluates its predicate and only candidate
  rows cross into JavaScript; adding field indexes remains a future optimization.
