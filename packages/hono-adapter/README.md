# Takibi Hono adapter

`@takibi/hono-adapter` mounts a Takibi HTTP handler on Hono.

```sh
npm install @takibi/hono-adapter
```

```ts
import { Hono, type Context } from "hono";
import { takibiServer } from "@takibi/hono-adapter";
import { handler } from "./takibi";
import type { AppEnv } from "./env";

const app = new Hono<AppEnv>();
// Install the application's authentication / DI middleware first.
app.use(
  "/api/takibi/*",
  takibiServer({
    handler,
    createContext: async (c: Context<AppEnv>) => ({
      env: c.env,
      session: await c.var.di.getSession(),
    }),
  }),
);
```

`createContext` runs per request and must return the input required by the
handler's `createTakibi<Input, Env>()` declaration. Synchronous and asynchronous
suppliers are supported. Empty input is supplied explicitly with `() => ({})`.

Mount on a **static prefix followed by `/*`**, or `*` / `/*` for the root.
The adapter reads the complete mounted route from Hono's `routePath`, including
static prefixes added with `app.route(...)`. Parameterized or embedded-wildcard
prefixes are not supported.

Takibi receives the original request URL and interprets collection, action and
`_batch` paths. It also handles the prefix root, trailing slashes and invalid deep
paths; neighboring prefixes are unaffected. Register more specific application
routes before the adapter when they should take priority. An unmatched handler
result continues to the next Hono middleware.

Authentication and request-header changes belong to preceding application
middleware. The adapter forwards `c.req.raw` and preserves response headers from
outer Hono middleware. The core handler itself has no Hono dependency and can
also be called directly with `handler.handle(request, { prefix, context })`.
