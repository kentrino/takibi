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
fails for the whole request.

When some actions must accept anonymous callers, `resolve` may return a nullable
identity (for example `user: User | null`) instead of throwing. Protect
authenticated actions with `.use()` on the action builder so AuthN failures stay
`UNAUTHORIZED` / 401 and role checks stay in the gate as `FORBIDDEN` / 403 — see
[Anonymous and protected actions](./docs/recipes/anonymous-protected-actions.md).

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
`createTakibi<Initial, Env>()`, then call the returned factory with
`{ resolve, stub?, services? }`. `TCtx` is inferred from `resolve`'s return
(annotate with `Promise<AppCtx>` when you want a named / wider type). `stub`
receives the same input plus the complete application-owned context as
`resolved` and returns a Durable Object stub — no library-side `env` /
`bindings` option. Empty initial uses `createTakibi()` (no type argument).

`services` is a synchronous factory `({ env }) => TServices` that runs once per
Durable Object instance in the generated constructor. Action handlers receive
the result as `services` — wire-crossing data stays on `ctx`, side-effect ports
stay on `services`. The factory never sees `request` or resolved `ctx`.
`services` is not placed on the Worker → Durable Object wire body, is not
JSON-safe-checked, and is invisible to collection `accessPolicy`, action
`.policy()` gates, and `.use()` guards. Omit `services` and handler
`services.foo` is a compile error.

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
const takibiApp = takibi.defineCollections({
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
// `defineCollections` returns an app definition; `app.actions({ ... })`
// registers the maps and returns the handler.
const handler = takibiApp.actions({});

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

Durable Object mode needs `stub` (and usually `handle` so AuthN / env reach
`resolve` / `stub`).

## Node integration tests

Use the Node-only `@takibi/takibi/testing` entry to exercise a production
handler against an isolated `DatabaseSync(":memory:")` database. The helper
reuses Takibi's production SQLite storage, migrations, index reconciliation,
seeds, actions, logging, and tracing paths. Each call creates a separate
database.

The returned handler implements `Symbol.dispose`; use `using` or call the
method from test teardown when a suite keeps handlers alive for a long time.

```ts
import { createClient } from "@takibi/takibi/client";
import { withSqliteTestBackend } from "@takibi/takibi/testing";

const handler = withSqliteTestBackend(takibiHandler, {
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

Omit `resolve` to keep the production resolver. Use that when tests call
`handle(request, { context })` with fake application dependencies.
`handler.request` has an empty initial context, so apps whose production
resolver needs session dependencies should pass a test resolver.

When `createTakibi()({ services })` is configured,
`withSqliteTestBackend(handler, { services })` takes the test services
**value**, not the production factory. The value is required when `TServices`
is non-empty. Omitting it is a compile error. Each test handler keeps its own
services.

This entry imports `node:sqlite` and is for Node integration tests only. Do not
import it from Worker or browser code. Workers tests must continue to use a real
SQLite-backed Durable Object when they verify `blockConcurrencyWhile`, stub
wiring, services factories, Durable Object concurrency, or other runtime
behavior that Node SQLite does not provide.

### Breaking migration from memory mode

The `{ memory: true }` option, `.with({ memory: true })`, and
`createMemoryStorage()` were removed without a compatibility overload. Migrate
test forks as follows:

```ts
// Before
const testHandler = productionHandler.with({ memory: true, resolve, services });

// After
const testHandler = withSqliteTestBackend(productionHandler, { resolve, services });
```

Import `withSqliteTestBackend` from `@takibi/takibi/testing`. Keep pure
query, policy, and protocol tests storage-free; the helper is for tests that
need storage-backed behavior.

On 2026-08-31, five warm `vp test` runs on the same development machine had a
0.77 s median before this migration and a 0.74 s median after it. The SQLite
backend therefore introduced no wall-clock regression that requires shared
databases or bypassing the production SQL path.

### Collection seeds

Use `seed` for production defaults. It returns schema inputs keyed by document
ID, so IDs do not need to be repeated inside document data:

```ts
const handler = context
  .defineCollections({
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
  })
  .actions({});
```

Seeds run before the Durable Object accepts requests and before Node SQLite test
backend storage operations. They are create-only: an existing document is never
overwritten, including when a Durable Object is reactivated. Adding another ID
to the returned record creates that default on the next activation. Seed values
are validated by the collection schema and bypass `accessPolicy`, like trusted
`$collections` operations.

### Unique constraints

Declare named top-level scalar key tuples with `unique`. Takibi checks them in
the same transaction as every `add`, `set`, and `update`, including public CRUD,
policy-bound collection calls, trusted `$collections`, seeds, and lazy
migration writes:

```ts
const members = context.defineCollection({
  schema: z.object({
    tenantId: z.string(),
    email: z.string().nullable().optional(),
  }),
  unique: {
    byTenantEmail: ["tenantId", "email"],
  },
  accessPolicy: fullAccess,
});
```

Constraint fields must be distinct top-level string, finite-number, or boolean
fields. A tuple containing a missing or `null` value does not participate, so
multiple documents may omit `email` in the example. Empty strings do
participate. Updates automatically exclude their own document ID. Status fields
have no special meaning: archived documents remain constrained unless status is
part of the tuple. Violations return `ALREADY_EXISTS` (409) and name the
constraint.

Unique checks currently scan the collection inside the write transaction; they
do not use a declared read index. Adding a constraint does not eagerly
audit untouched existing documents, so clean up historical duplicates before
deploying it.

### Lazy document migrations

Use `migrations` when a collection schema changes incompatibly. Each step
converts one stored document version to the next; a document is migrated on
access before it reaches `accessPolicy`, action code, query filtering, or a
write merge:

```ts
type SettingsV0 = { bookingUrl: string };

const handler = context
  .defineCollections({
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
  })
  .actions({});
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

`accessPolicy` receives `doc` / `nextDoc` (schema output plus `id` / `createdAt` / `updatedAt` / `rev`) so you can authorize on document attributes — not only collection-level actions:

| operation                | `doc`                               | `nextDoc`                    |
| ------------------------ | ----------------------------------- | ---------------------------- |
| add                      | —                                   | validated create candidate   |
| get                      | saved value                         | —                            |
| list                     | —                                   | —                            |
| update                   | saved value                         | merge + validation candidate |
| delete                   | saved value                         | —                            |
| set                      | saved value if present, else absent | validated replace candidate  |
| invoke (document action) | target document (gate)              | —                            |

Missing get / update / delete never call `accessPolicy` (`NOT_FOUND`). Denying get / update / delete / **set** also returns `NOT_FOUND` so IDs are not leaked — `set` uses the same code for a new id and an existing id. Denying create (`add`) / list returns `FORBIDDEN`. Denying a document-action gate returns `FORBIDDEN` when the document exists; a missing id is `NOT_FOUND`.

### Grants: `fullAccess` / `write` / `read` / `none` / `grant(...)`

`accessPolicy` returns an **`AccessGrant`** — an opaque value for the permissions the subject may perform on this collection / document — not a yes/no for the current request. Build a grant with `grant(...)` or a predefined grant (`fullAccess` / `write` / `read` / `none`) and return it from the policy. The executor allows the call when that grant includes the required `permission` (`create` / `get` / `list` / `update` / `delete` / `invoke`).

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

`context.policy` keeps reusable `accessPolicy` functions typed with `user` from
`resolve` and, when you pass a schema, types `doc` / `nextDoc` inside the
callback. Pass the collection schema or a pick of its fields. A pick-schema
policy assigns to a collection iff those keys exist on the document (optional
vs required does not matter). `and` / `or` infer that pick from their arguments.

`and` intersects grants; `or` unions them. Import the root functions. Identity
rules and document rules compose:

```ts
import { and, fullAccess, none, read } from "@takibi/takibi";

const staffPolicy = context.policy(({ user }) => (user != null ? fullAccess : none));
const isSeededData = context.policy(itemSchema, ({ doc, nextDoc }) =>
  doc?.isSeeded || nextDoc?.isSeeded ? read : fullAccess,
);

const handler = context
  .defineCollections({
    items: {
      schema: itemSchema,
      accessPolicy: and(staffPolicy, isSeededData),
    },
  })
  .actions({});
```

Staff can read and write unseeded documents and invoke actions; seeded documents
stay readable. `and(staffPolicy, read)` is the same pattern with a constant
grant.

#### Public policy denial reasons

A policy can declare one static, machine-readable reason. Use
`{ schema, reason }` for a schema-bound policy or `{ reason }` for a
context-only policy:

```ts
const seededDataPolicy = context.policy(
  {
    schema: z.object({ isSeeded: z.boolean() }),
    reason: {
      code: "SEEDED_DATA_IMMUTABLE",
      description: "Seeded data cannot be modified.",
    },
  },
  ({ doc }) =>
    doc?.isSeeded ? read : grant("create", "get", "list", "update", "delete", "invoke"),
);
```

`reason.code` stays a literal union through `and` / `or`, collection and action
definitions, `TakibiResult`, and `ClientOf<typeof handler>`. `description` is an
optional developer description. Both values are serialized, so they must be
static, public, and free of document data, identity data, secrets, or other
sensitive details. Do not use `description` as localized UI copy.

When `and` denies a permission, the first policy in declaration order that
drops that permission supplies the reason. When `or` denies because every
policy drops the permission, only the first policy supplies the reason. If that
selected policy has no reason, Takibi does not fall back to a later policy.
Existing `and` / `or` short-circuit order is unchanged.

Reasons are exposed only on `FORBIDDEN` failures from add, list, and action
gates. Concealed get, update, delete, and set denials remain `NOT_FOUND` with no
reason. Missing documents, `UNAUTHORIZED`, and validation failures also never
carry one. Policies without a reason keep the existing generic failure.

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
when AuthN or storage-partition authorization fails for the whole request. When
anonymous actions share the same handler, return a nullable identity from
`resolve` and use action `.use()` for per-action AuthN — see
[Anonymous and protected actions](./docs/recipes/anonymous-protected-actions.md).
Takibi validates that the resolved context is a JSON-safe object but does not
interpret its keys.

### Actions

Use actions for named server-side work that CRUD cannot express. Actions are
defined on the app definition returned by `defineCollections`:
`app.<collection>.actions(cb)` for collection actions, `app.defineAction()`
for root actions. Register every action map with a single `app.actions({ ... })`
call (root actions go under the reserved `$` key) to obtain the handler.

A collection `defineAction()` starts as a **document action**: it targets one
existing document, the client passes the target id as the first argument, and
the handler receives `{ id, doc }` without re-fetching. Call `.detached()`
(before `.input()` / `.policy()`) for actions that are not bound to one
existing document — creation, aggregation, no-target pings.

Call `.use(fn)` only immediately after `defineAction()` (or another `.use()`)
to refine the handler and gate context — typically to require a signed-in user
when `resolve` returns a nullable identity. Guards run before document load and
gate evaluation; thrown `UnauthorizedError` becomes `UNAUTHORIZED` / 401.
Public actions omit `.use()` and name an explicit invoke grant. See
[Anonymous and protected actions](./docs/recipes/anonymous-protected-actions.md).

```ts
const posts = context.defineCollection({
  schema: postSchema,
  accessPolicy: postPolicy,
});
const app = context.defineCollections({ posts });

const postsActions = app.posts.actions((defineAction) => ({
  duplicate: defineAction()
    .input(z.object({ title: z.string() }))
    .policy(staffPolicy)
    .handler(async ({ input, doc, collection }) => {
      const { id: _id, createdAt: _c, updatedAt: _u, rev: _rev, ...fields } = doc;
      return collection.add({ ...fields, title: input.title });
    }),
  stats: defineAction()
    .detached()
    .requires("list")
    .policy(staffPolicy)
    .handler(async ({ collection }) => {
      const page = await collection.list();
      return { count: page.items.length };
    }),
}));

const exportAll = app
  .defineAction()
  .policy(staffPolicy)
  .handler(async ({ collections }) => ({
    posts: (await collections.posts.list()).items,
  }));

const handler = app.actions({ $: { exportAll }, posts: postsActions });
```

Every action handler receives `collections` / `$collections` (all collections);
collection-scope actions additionally receive the shorthand
`collection` / `$collection` for their own collection. Document actions also
receive `{ id, doc }` — `doc` is the target document (schema output plus
metadata), fetched before the handler runs. A missing id fails with
`NOT_FOUND` before the handler.

`.input(...)` takes a Standard Schema, including refinements. Document action
inputs must not contain the target id — the id travels in the path. Input
failures become `{ kind: "validation", code: "VALIDATION" }` with field
`issues`. Throw a `TakibiError` subclass from the handler for operation
failures.

Every action has a mandatory gate policy. A document action's `.policy()`
accepts the same schema-bound policy as that collection's `accessPolicy` and
evaluates it **with the target document**
(`{ operation: "invoke", permission, doc }`), so document-attribute rules work
in the gate. A gate callback receives `target: { id, doc }`. A missing document
is `NOT_FOUND`. Gate denial on a found document is `FORBIDDEN` — existence
concealment stays on CRUD get / update / delete / set.

Detached and root actions have no target document: their gate takes a grant, a
context-only policy, or a gate callback (without `target`) — schema-bound
policies are rejected at the type level and with `INVALID_ACTION` at
registration. Gate denial is `FORBIDDEN`.

Normal `collection` / `collections` CRUD evaluates each collection's
`accessPolicy`; `$collection` / `$collections` bypasses only that document
policy and never bypasses the action gate. These server-side facades throw
`TakibiError` on failure.

Add `.atomic()` before `.handler()` when all Takibi collection storage
operations in an action must commit or roll back together:

```ts
const placeOrder = app
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

For detached and root actions the gate and input validation run before the
transaction. The handler, collection schema validation and storage operations,
`void`-to-`null` normalization, and JSON output validation run inside it; they
commit only when all succeed. An atomic **document** action runs the target
lookup, gate, input parse, and handler inside one transaction, so the `doc` the
handler receives is consistent with its writes. Any thrown failure rolls back
writes already completed by that atomic action. Actions without `.atomic()`
keep the normal per-operation behavior, so an earlier write remains after a
later failure.

Atomic actions cover only operations performed through Takibi's
`collection(s)` / `$collection(s)` facades. HTTP requests, email, queue
publishes, and other external side effects cannot be rolled back, even when
they occur inside an atomic handler. Split those effects into a separate action
or use an application-level delivery pattern when they must be coordinated.

The public client is flat; document actions take the target id first:

```ts
await client.posts.duplicate("p1", { title: "Copy" }); // document action
await client.posts.stats(); // detached action
await client.exportAll(); // root action
```

Document actions use `POST {baseUrl}/{collection}/{id}:{name}` (the id is
percent-encoded, so an id containing `:` travels as `%3A`). Detached collection
actions use `POST {baseUrl}/{collection}:{name}` and root actions use
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
| `list`    | `GET {baseUrl}/{collection}?limit=&cursor=&where=&index=&orderBy=`                   |

`listAll` is a client convenience over repeated `list` calls, not a new HTTP
operation or policy permission. It reuses `list` (and its grant) page by page,
follows `nextCursor`, and returns the concatenated documents. Configure the
safety cap on `createClient`; the call site may only lower `pageSize` and
`maxItems`. Remaining documents after `maxItems` fail with `LIST_ALL_LIMIT`
instead of truncating.

`POST` / `PUT` / `PATCH` bodies are the document input (not an internal wire request).
`GET` / `DELETE` have no body. Worker→Durable Object forwarding stays an internal
JSON POST and is not part of the public HTTP contract.

Opt-in batching of collection reads coalesces nearby `get` / `list` calls into one
`POST {baseUrl}/_batch`. The first queued read starts a fixed window of
`maxWaitMs` extra wait; later reads in that window do not extend the deadline.
`0` waits only until the next timer task. Writes and actions skip the queue and
go to their existing endpoints immediately. They neither flush a pending read
batch nor change its deadline, and Takibi does not guarantee ordering between a
read batch and those immediate requests — wait for the earlier Promise if the
next call depends on it. All items in a batch share the headers captured at
flush, the resolved context, and the tenant. One item's operation failure is
returned to that Promise and does not reject the others. At most 20 reads share
a batch by default. Set `maxSize` from 1 through 20 to flush earlier; `1`
sends every read immediately in its own batch request.

```ts
const client = createClient<Handler>("https://localhost:3000/foo", {
  batch: { maxWaitMs: 10, maxSize: 20 },
  headers: () => ({
    Authorization: `Bearer ${getAccessToken()}`,
  }),
});
```

Omit `batch` to keep one REST fetch per call.

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

For a typed policy denial, keep `FORBIDDEN` as the operation classification and
map `reason.code` to client-owned localized copy. Always fall back to the
existing operation message when the reason is absent or unknown:

```ts
const result = await client.items.archive(id);
if (!result.ok && result.error.kind === "operation") {
  const message =
    result.error.code === "FORBIDDEN" && result.error.reason?.code === "SEEDED_DATA_IMMUTABLE"
      ? t("errors.seededDataImmutable")
      : result.error.message;
  showError(message);
}
```

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
via `Date.prototype.toISOString()`, e.g. `2026-08-09T14:12:00.000Z`) and `rev` (a positive
integer). Do not define those fields — or reserved `id` and `$schemaVersion` — in the
collection schema. `defineCollection` rejects those keys at the type level; both input own
properties and schema transforms that emit them fail validation. `add` and create-via-`set`
set both timestamps to the same write-time value and start `rev` at `1`; overwrite
`set` / `update` keep `createdAt`, refresh `updatedAt`, and increment `rev` even when
field values are unchanged. Same-millisecond writes may share a timestamp. Rows stored
without `rev` read as `1`.

`createdAt` / `updatedAt` are observational only — not revisions, ETags, or optimistic
lock tokens. Use `rev` for that. Include the document's current `rev` on `set` /
`update` to require that generation; a mismatch or a `rev`-qualified write to a missing
document fails with `STALE_WRITE` (409) and leaves storage unchanged. Omitting `rev`
keeps last-write-wins. `add` still rejects `rev`. `list.where` cannot query `rev`.

### List queries

`list.where` is a typed AST builder callback, not a JavaScript predicate over
documents. It runs synchronously once in the client or server facade and sends
only the normalized expression to the server:

```ts
const page = await client.posts.list({
  where: (query) => query.and(query.ownerId.eq(currentUser.id), query.createdAt.gte(yesterday)),
  limit: 50,
});

const published = await client.posts.listAll({
  where: (query) => query.published.eq(true),
});
```

Every top-level field supports `present()`, which tests whether the document has
that key; a stored JSON `null` value is present. Use
`query.not(query.optionalField.present())` to match a missing optional field.
Top-level scalar fields support `eq`; string and number fields also support
`gt`, `gte`, `lt`, and `lte`. Scalar fields also support `in` with 1–32
values. String fields support case-sensitive `contains`, `startsWith`, and
`endsWith`; an empty search string matches every stored string. Compose
expressions with `and`, `or`, and `not`:

```ts
const page = await client.appointments.list({
  where: (query) =>
    query.and(
      query.status.in(["pending", "confirmed"]),
      query.email.endsWith("@clinic.example"),
      query.not(query.token.in(revokedTokens)),
    ),
});
```

Unindexed `list` results stay in document id order. Filtering happens before
`cursor` and `limit`.

Declare named composite indexes on required top-level `string` / finite `number`
fields plus `id` / `createdAt` / `updatedAt`. `index` selects that field order;
it is not a planner hint. Omit `index` to keep the existing id-ascending scan.
`orderBy` is allowed only with `index`, and only for a field of that index.
Fields before the chosen order field must be single-value equalities in `where`;
otherwise the request is `BAD_REQUEST` and does not fall back to another scan
or an in-memory sort.

```ts
const posts = context.defineCollection({
  schema: postSchema,
  indexes: {
    byOwner: ["ownerId", "createdAt"],
    byStatus: ["status", "updatedAt"],
  },
  accessPolicy,
});

const page = await client.posts.list({
  index: "byOwner",
  where: (query) => query.ownerId.eq(user.id),
  orderBy: (query) => query.createdAt.desc(),
  limit: 20,
});
```

Equality prefix plus one range field can narrow the index; remaining `where`
clauses are residual predicates. `limit` applies after that filter. Indexed
cursors bind collection, query, index descriptor, order field, direction, and
the last index tuple. Reuse a cursor only with that same request.

Indexed collections backfill existing documents to the current schema when the
index is added or the document schema version advances. That backfill runs
during Durable Object activation and blocks request handling for that tenant
until it succeeds. Writes still go only to `takibi_documents`; SQLite
expression indexes maintain themselves and add write amplification on those
columns. There is no unindexed `orderBy` and no automatic index selection.

The SQLite storage implementation compiles predicates to parameterized SQL,
uses the declared expression index for the chosen order, and performs a final
JavaScript check to preserve missing / null / type semantics. The Node test
backend exercises this same storage path. Treat `nextCursor` as opaque; do not
inspect, modify, or guess cursor values.

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
const pending = await this.$collections.posts.count({
  where: (query) => query.status.eq("pending"),
});
```

Use `$transaction` on the trusted collections facade to commit or roll back
mutations across collections as one storage transaction:

```ts
await this.$collections.$transaction(async ($collections) => {
  await $collections.orders.add(order);
  await $collections.inventory.update(itemId, { stock });
});
```

Nested `$transaction` calls join the enclosing transaction.

Server-side policy-bound collections and trusted `$collections` expose
`count`, which pages through the same query, index selection, and migration
transforms as `list`. A policy-bound count requires the `list` permission.
`count` is not available on the public HTTP client.

Trusted `$collections` additionally expose atomic conditional writes:

```ts
await this.$collections.posts.updateMany(
  { archived: true },
  { where: (query) => query.ownerId.eq(ownerId), index: "byOwner" },
);
await this.$collections.sessions.deleteMany({
  where: (query) => query.userId.eq(userId),
});
const token = await this.$collections.verifications.consumeOne({
  where: (query) => query.value.eq(value),
});
const counter = await this.$collections.counters.incrementOne(
  { attempts: 1 },
  {
    where: (query) => query.id.eq(id),
    set: { lastAttemptAt: new Date().toISOString() },
  },
);
```

The `where` clause is mandatory. Bulk operations process every match;
`consumeOne` and `incrementOne` use the first document in normal `list` order.
They join an enclosing trusted/action transaction or open one when called
directly. These methods bypass collection policy and are unavailable through
policy-bound collections, the public client, and HTTP.

Documents are stored with `state.storage.sql` in one library-managed
`takibi_documents` table shared by all collections in the Durable Object. Domain
fields are JSON text; collection, id, timestamps, and document schema version are
separate columns. The server-managed `rev` is also stored in a dedicated `REAL NOT
NULL` column, not in the domain JSON, so revisions above JavaScript's safe-integer and
SQLite's signed 64-bit integer boundaries retain their IEEE-754 value. Takibi does not
create a table or columns from each application schema, and applications do not manage
or query this internal table.

Auto-generated document ids are monotonic ULIDs (26 Crockford Base32 characters).
Caller-supplied ids are still accepted; creation-order lexicographic sort is
guaranteed only for library-generated ULIDs.

Takibi versions its internal SQL layout in `takibi_metadata` and migrates known
layout versions synchronously during activation. A newer unknown layout fails closed.
Layout version 2 moves a valid version 1 `data.rev` value into the revision column,
defaults a missing or invalid legacy value to `1`, and removes `rev` from the JSON.
The table rebuild and layout-version update are one transaction.
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

Logging and tracing are separate signals. Both are off by default. Configure a
logger on `createTakibi()`, `defineCollections()`, or
`withSqliteTestBackend()`; the more local setting wins field by field:

```ts
import { createPrettyConsoleLogger, createTakibi } from "@takibi/takibi";
import { withSqliteTestBackend } from "@takibi/takibi/testing";

const takibi = createTakibi()({
  resolve,
  stub,
  logger: createPrettyConsoleLogger(),
  logLevel: "debug",
});

const production = takibi.defineCollections(definitions, { logLevel: "info" }).actions({});
const silent = takibi.defineCollections(definitions, { logger: false }).actions({});
const captured = withSqliteTestBackend(production, { logger: testLogger });
```

`logger: true` sends the `LogEvent` object directly to the matching
`console.debug` / `info` / `warn` / `error` method so platform structured fields
are preserved. Supplying only `logLevel` enables the same structured console
logger. The default level for an enabled logger is `info`;
`debug < info < warn < error`. `createPrettyConsoleLogger()` is a dependency-free
single-line formatter for local development, not a production structured logger
or an OpenTelemetry exporter. ANSI colors are off unless `{ colors: true }` is
explicitly passed, and it does not add a timestamp. Logger failures are ignored
and never change a request result.

Takibi logs request boundaries and failures at `info` / `error`, and emits
`debug` timing events for resolve, Worker → Durable Object wire, executor,
policy, schema, storage, and actions. A failure log uses the public error
message (not a generic "request failed") and includes the HTTP method and
path so decode-time errors are diagnosable without opening a trace. Events
can contain only operation metadata: collection, operation, document ID,
HTTP method/path, duration, error code/status, the normalized list query
AST, and batch size for batched reads. They never contain documents, action
input or output, resolved context, request/response bodies or headers, cookies,
credentials, stubs, or bindings.
A query comparison value can still be a name, phone number, or other personal
data. Restrict access to debug logs and retain them only briefly.

Install `@takibi/takibi-opentelemetry` to enable OpenTelemetry spans and,
optionally, map permitted `LogEvent` values to OpenTelemetry Logs. The
integration package owns its OpenTelemetry peer dependencies, adapters, setup
documentation, and tests; the core package has no OpenTelemetry dependency.
Export logs and traces to the same observability backend when you need native
trace-log correlation. `logger: true` writes structured console output only; it
does not export OpenTelemetry logs. See the integration package README for
providers, context management, correlation, and Workers flushing.

Takibi core owns span semantics as well as span placement. `takibi.wire` is a
client span, a Durable Object `takibi.executor` is a server span, and local
executor, policy, schema, storage, and action work is internal. Relevant spans
carry only operation metadata: `takibi.collection.name`,
`takibi.operation.name`, `takibi.action.name`, `takibi.action.scope`,
`takibi.storage.operation`, `takibi.batch.size` on batched reads, and, when
available, `takibi.document.id`. They do
not include document contents, resolved context, request headers, or action
input/output. Core also decides exception normalization and error status; the
integration package only maps that structural contract to OpenTelemetry.

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
- `list` returns full documents. Without `index` the order is id ascending.
  With `index`, order follows the declared field tuple (and `orderBy` on that
  index). It does not offer unindexed `orderBy`, offset, or projection. Each
  page defaults to **50** documents and is capped at **200**. `listAll` walks
  those pages (default page size 200) and stops at a client safety cap of
  **10_000** documents unless `createClient({ listAll })` or the call site sets
  a smaller `maxItems`.
- `where` remains an arbitrary boolean AST. Indexed lists scan the selected
  index in its declared order and apply residual predicates before `limit`.
  Unindexed lists may still scan the collection.
