import { Hono, type Context } from "hono";
import { expect, expectTypeOf, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createTakibi } from "@takibi/takibi-worker-runtime";
import { fullAccess } from "@takibi/takibi-policy";
import { withSqliteTestBackend } from "@takibi/takibi-testing";
import { takibiServer } from "../src";

type AppEnv = {
  Bindings: { tenant: string };
  Variables: { di: { getSession(): Promise<string> } };
};
type Input = { env: AppEnv["Bindings"]; session: string };

function fixture() {
  const resolved: Input[] = [];
  const context = createTakibi<Input>()({
    resolve: ({ context, request }) => {
      resolved.push(context);
      return {
        tenantId: context.env.tenant,
        session: context.session,
        authOrigin: request.headers.get("x-auth-origin"),
      };
    },
  });
  const app = context.defineCollections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
      seed: () => ({ "a:b": { title: "encoded id" } }),
    },
  });
  const posts = app.posts.actions((defineAction) => ({
    inspect: defineAction()
      .policy(fullAccess)
      .handler(({ id, ctx }) => ({ id, session: ctx.session, authOrigin: ctx.authOrigin })),
  }));
  const ping = app
    .defineAction()
    .policy(fullAccess)
    .handler(() => "pong");
  const handler = withSqliteTestBackend(app.actions({ posts, $: { ping } }));
  const createContext = vi.fn(async (c: Context<AppEnv>) => ({
    env: c.env,
    session: await c.var.di.getSession(),
  }));
  const hono = new Hono<AppEnv>();
  hono.use("*", async (c, next) => {
    c.set("di", { getSession: async () => "signed-in" });
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-auth-origin", "https://app.test");
    c.req.raw = new Request(c.req.raw, { headers });
    c.header("x-outer", "preserved");
    await next();
  });
  return { handler, hono, createContext, resolved };
}

test("group mounts delegate root, collection, batch, actions and invalid paths to core", async () => {
  const { handler, hono, createContext, resolved } = fixture();
  using _cleanup = handler;
  const group = new Hono<AppEnv>().use("/takibi/*", takibiServer({ handler, createContext }));
  hono.route("/api", group);
  hono.all("*", (c) => c.text("outside", 418));
  const request = (path: string, init?: RequestInit) =>
    hono.request(path, init, { tenant: "tenant-a" });

  for (const path of ["/api/takibi", "/api/takibi/"]) {
    expect((await request(path)).status).toBe(400);
  }
  for (const path of ["/api/takibi/posts/a%3Ab", "/api/takibi/posts/a%3Ab/"]) {
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-outer")).toBe("preserved");
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { id: "a:b" } });
  }
  const action = await request("/api/takibi/posts/a%3Ab:inspect", { method: "POST" });
  await expect(action.json()).resolves.toMatchObject({
    ok: true,
    data: { id: "a:b", session: "signed-in", authOrigin: "https://app.test" },
  });
  const ping = await request("/api/takibi/$:ping", { method: "POST" });
  await expect(ping.json()).resolves.toMatchObject({ ok: true, data: "pong" });
  const batch = await request("/api/takibi/_batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "batch",
      items: [
        { kind: "collection", collection: "posts", operation: "get", id: "a:b" },
        { kind: "collection", collection: "posts", operation: "list" },
      ],
    }),
  });
  expect(batch.status).toBe(200);
  await expect(batch.json()).resolves.toMatchObject({ ok: true });
  expect((await request("/api/takibi/posts/a/b")).status).toBe(404);
  expect((await request("/api/takibi/_batch/deep", { method: "POST" })).status).toBe(400);
  const calls = createContext.mock.calls.length;
  for (const path of ["/api/takibix/posts", "/other/posts", "/api"]) {
    const response = await request(path);
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("outside");
  }
  expect(createContext).toHaveBeenCalledTimes(calls);
  expect(resolved).toContainEqual({ env: { tenant: "tenant-a" }, session: "signed-in" });
});

test("root wildcard supplies empty input explicitly", async () => {
  using handler = withSqliteTestBackend(
    createTakibi()({ resolve: () => ({ tenantId: "root" }) })
      .defineCollections({
        posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
      })
      .actions({}),
  );
  for (const path of ["*", "/*"]) {
    const app = new Hono().use(path, takibiServer({ handler, createContext: () => ({}) }));
    expect((await app.request("/posts")).status).toBe(200);
    expect((await app.request("/")).status).toBe(400);
  }
});

test("unmatched handlers yield to later middleware", async () => {
  const app = new Hono().use(
    "/rpc/*",
    takibiServer({
      handler: { handle: async () => ({ matched: false }) },
      createContext: () => ({}),
    }),
  );
  app.get("/rpc/fallback", (c) => c.text("fallback"));
  expect(await (await app.request("/rpc/fallback")).text()).toBe("fallback");
});

test("context is checked against handler input independently of Hono bindings", () => {
  const handler = createTakibi<Input>()({
    resolve: ({ context }) => ({ tenantId: context.env.tenant }),
  })
    .defineCollections({})
    .actions({});
  const valid = takibiServer({
    handler,
    createContext: (c: Context<AppEnv>) => ({ env: c.env, session: "ok" }),
  });
  expectTypeOf(valid).toBeFunction();
  const invalid = () => {
    takibiServer<unknown, AppEnv>({
      // @ts-expect-error explicit type arguments cannot widen a handler's accepted input
      handler,
      createContext: () => ({}),
    });
    takibiServer({
      handler,
      // @ts-expect-error missing session cannot widen the handler's input
      createContext: (c: Context<AppEnv>) => ({ env: c.env }),
    });
    takibiServer({
      handler,
      // @ts-expect-error async suppliers must also return the required input types
      createContext: async (c: Context<AppEnv>) => ({ env: c.env, session: 123 }),
    });
    takibiServer({
      handler,
      // @ts-expect-error Hono bindings must match the input contract
      createContext: (c: Context<{ Bindings: { tenant: number } }>) => ({
        env: c.env,
        session: "ok",
      }),
    });
  };
  expectTypeOf(invalid).toBeFunction();
});
