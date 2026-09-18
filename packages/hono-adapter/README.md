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
app.route(
  "/api/takibi",
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

`takibiServer` returns a Hono app. Mount it with `app.route("/api/takibi", server)`
or `app.route("/", server)` for the root; no wildcard suffix is needed.
The adapter uses Hono's `basePath(c)` to resolve the complete mount path,
including nested mounts and request parameters. Hono owns route matching
and parameter resolution.

Takibi receives the original request URL and interprets collection, action and
`_batch` paths. It also handles the prefix root, trailing slashes and invalid deep
paths; neighboring prefixes are unaffected. Register more specific application
routes before the adapter when they should take priority. An unmatched handler
result continues to the next Hono middleware.

Authentication and request-header changes belong to preceding application
middleware. The adapter forwards `c.req.raw` and preserves response headers from
outer Hono middleware. WebSocket upgrades (status 101) are returned as
the original Response because Hono cannot reconstruct them. The core handler itself has no Hono dependency and can
also be called directly with `handler.handle(request, { stripPrefix, context })`.
The adapter passes a `stripPrefix` function that removes the matched mount path;
the original `Request` is passed through unchanged. Direct callers can supply a
literal prefix string instead, or omit it to use the whole pathname.
