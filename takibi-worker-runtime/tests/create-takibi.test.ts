import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import type { ActionDefinitions } from "@takibi/takibi-api";
import { createClient } from "@takibi/takibi-client";
import { withSqliteTestBackend } from "../../takibi-testing/src/index";
import { createSqliteDurableObjectStorage } from "../../takibi-testing/src/sqlite-storage.server";
import * as Policy from "@takibi/takibi-policy";
import { fullAccess, grant, none, type AccessContext } from "@takibi/takibi-policy";
import { createTakibi, type TakibiHandler } from "../src";
import type { WireRequest, WireResponse } from "../src";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

function resolveTestContext({ request }: { request: Request }): AppCtx {
  const raw = request.headers.get("x-test-user");
  return {
    tenantId: request.headers.get("x-test-tenant") ?? "",
    user: raw ? (JSON.parse(raw) as User) : null,
  };
}

function headers(user: User | null = { id: "u1", role: "member" }): Headers {
  const value = new Headers({ "x-test-tenant": "tenant-a" });
  if (user) value.set("x-test-user", JSON.stringify(user));
  return value;
}

const Post = z.object({
  title: z.string().min(1),
  secret: z.boolean().default(false),
});

function postPolicy({ user, doc, nextDoc }: AccessContext<AppCtx>): ReturnType<typeof grant> {
  if (user?.role === "admin") return fullAccess;
  if (!user) return none;
  if (doc?.secret === true || nextDoc?.secret === true) return grant("list");
  return fullAccess;
}

function createActionApp() {
  const context = createTakibi()({ resolve: resolveTestContext });
  const staff = context.policy(({ user }) => (user ? fullAccess : none));
  const postGate = context.policy(Post, postPolicy);

  const posts = context.defineCollection({
    schema: Post,
    accessPolicy: postPolicy,
  });
  const audits = context.defineCollection({
    schema: z.object({ action: z.string() }),
    accessPolicy: fullAccess,
  });
  const app = context.defineCollections({ posts, audits });

  const postsActions = app.posts.actions((defineAction) => ({
    duplicate: defineAction()
      .input(z.object({ title: z.string().min(1) }))
      .policy(postGate)
      .handler(({ input, doc, collection, ctx }) =>
        collection.add({
          title: `${input.title}:${ctx.user?.id ?? "none"}`,
          secret: doc.secret,
        }),
      ),
    audited: defineAction()
      .policy(staff)
      .handler(async ({ id, $collections }) => {
        await $collections.audits.add({ action: `audited:${id}` }, { id: `audit-${id}` });
        const page = await $collections.audits.list();
        return { audits: page.items.length };
      }),
    stats: defineAction()
      .detached()
      .requires("list")
      .policy(Policy.read)
      .handler(async ({ collection }) => {
        const page = await collection.list();
        return { count: page.items.length };
      }),
    ping: defineAction()
      .detached()
      .policy(staff)
      .handler(() => ({ pong: true })),
    noContent: defineAction()
      .detached()
      .policy(staff)
      .handler(() => undefined),
  }));

  const exportAll = app
    .defineAction()
    .policy(staff)
    .handler(async ({ ctx, collections }) => {
      const page = await collections.posts.list();
      return { by: ctx.user?.id ?? "none", titles: page.items.map((post) => post.title) };
    });
  const handler = withSqliteTestBackend(app.actions({ $: { exportAll }, posts: postsActions }));
  return { app, handler };
}

function clientFor(
  handler: ReturnType<typeof createActionApp>["handler"],
  user: User | null = { id: "u1", role: "member" },
) {
  return createClient<typeof handler>("http://fire.test", {
    headers: () => headers(user),
    fetch: (input, init) => handler.request(input, init),
  });
}

function createFakeDurableObjectState(
  storage: DurableObjectStorage,
  id: { name?: string } = {},
): DurableObjectState {
  return {
    storage,
    id,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

test("createTakibi infers handler collections from defineCollections", () => {
  const handler = createTakibi()({
    resolve: (): AppCtx => ({ tenantId: "t", user: null }),
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  expectTypeOf(handler).toHaveProperty("handle");
  expectTypeOf(handler).toHaveProperty("DurableObject");
  type _Handler = TakibiHandler;
  expectTypeOf<_Handler>().not.toBeNever();
});

test("CRUD and collection/root actions roundtrip through the SQLite test backend", async () => {
  const { handler } = createActionApp();
  expect(handler).not.toHaveProperty("$collections");
  const client = clientFor(handler);

  const created = await client.posts.add({ title: "first" }, { id: "p1" });
  expect(created).toMatchObject({ ok: true, data: { id: "p1", title: "first", secret: false } });

  const ping = await client.posts.ping();
  expect(ping).toEqual({ ok: true, data: { pong: true } });

  const stats = await client.posts.stats();
  expect(stats).toEqual({ ok: true, data: { count: 1 } });

  const exported = await client.exportAll();
  expect(exported).toEqual({ ok: true, data: { by: "u1", titles: ["first"] } });

  const noContent = await client.posts.noContent();
  expect(noContent).toEqual({ ok: true, data: null });
});

test("document actions read and write other collections through $collections", async () => {
  const { handler } = createActionApp();
  const client = clientFor(handler);
  await client.posts.add({ title: "first" }, { id: "p1" });
  const audited = await client.posts.audited("p1");
  expect(audited).toEqual({ ok: true, data: { audits: 1 } });
});

test("duplicate add returns ALREADY_EXISTS as an operation failure", async () => {
  const { handler } = createActionApp();
  const client = clientFor(handler);
  expect(await client.posts.add({ title: "first" }, { id: "p1" })).toMatchObject({ ok: true });
  const duplicate = await client.posts.add({ title: "again" }, { id: "p1" });
  expect(duplicate).toEqual({
    ok: false,
    error: {
      kind: "operation",
      code: "ALREADY_EXISTS",
      message: "Document already exists: p1",
      status: 409,
    },
  });
});

test("set policy denial conceals existence for new and existing ids", async () => {
  const { handler } = createActionApp();
  await clientFor(handler, { id: "admin", role: "admin" }).posts.add(
    { title: "hidden", secret: true },
    { id: "secret" },
  );
  const member = clientFor(handler);
  expect(await member.posts.get("secret")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(await member.posts.set("secret", { title: "leak", secret: true })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(await member.posts.set("missing", { title: "ghost", secret: true })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
});

test("collection registration rejects malformed unique declarations at runtime", () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const definition = {
    schema: Post,
    accessPolicy: fullAccess,
  };

  for (const unique of [
    { empty: [] },
    { duplicate: ["title", "title"] },
    { invalid: [""] },
    { "not-safe": ["title"] },
  ]) {
    expect(() =>
      context.defineCollections({
        posts: { ...definition, unique } as never,
      }),
    ).toThrow(/unique constraint/);
  }
});

test("action registration validates definitions", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: { id: "u", role: "admin" as const } }),
  });
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const valid = app
    .defineAction()
    .policy(fullAccess)
    .handler(() => ({ ok: true }));
  const invalid = { ...valid, kind: "collection" } as never;
  const register = (definitions: ActionDefinitions) => app.actions({ $: definitions } as never);

  expect(() => register({ valid, invalid })).toThrow(/Invalid root action/);
  expect(() => register({ posts: valid })).toThrow(/reserved name/);
  expect(() => register({ bind: valid })).toThrow(/Invalid action name/);
  expect(() =>
    register({
      badPermission: { ...valid, permission: "admin" } as never,
    }),
  ).toThrow(/Invalid action permission/);
  expect(() =>
    register({
      badPolicy: { ...valid, policy: grant("admin" as never) } as never,
    }),
  ).toThrow(/Invalid action policy grant/);
  expect(() =>
    register({
      badSchema: { ...valid, inputSchema: {} } as never,
    }),
  ).toThrow(/Invalid action input schema/);
  const hidden = {};
  Object.defineProperty(hidden, "hidden", {
    value: valid,
    enumerable: false,
  });
  expect(() => register(hidden as ActionDefinitions)).toThrow(/enumerable data properties/);
  expect(() => register({ [Symbol("hidden")]: valid } as ActionDefinitions)).toThrow(
    /names must be strings/,
  );
  expect(() => app.actions({ ghosts: {} } as never)).toThrow(/Unknown action scope/);
  const first = register({ valid });
  const second = register({ valid });
  expect(second).not.toBe(first);
});

test("collection registration rejects hidden, symbol, and inherited entries", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  const definition = { schema: Post, accessPolicy: fullAccess };
  const hidden = {};
  Object.defineProperty(hidden, "posts", {
    value: definition,
    enumerable: false,
  });

  expect(() => context.defineCollections(hidden as never)).toThrow(/enumerable data properties/);
  expect(() => context.defineCollections({ [Symbol("posts")]: definition } as never)).toThrow(
    /names must be strings/,
  );
  expect(() => context.defineCollections(Object.create({ posts: definition }) as never)).toThrow(
    /plain object/,
  );
  expect(() => context.defineCollections({ actions: definition } as never)).toThrow(
    /Invalid collection name/,
  );
  expect(() => context.defineCollections({ defineAction: definition } as never)).toThrow(
    /Invalid collection name/,
  );
});

test("invalid wire envelopes are BAD_REQUEST on Worker and DO paths", async () => {
  let object: DurableObject;
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
    stub: () => object as unknown as DurableObjectStub,
  });
  const handler = context
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );

  const badRequest = { ok: false, error: { kind: "operation", code: "BAD_REQUEST", status: 400 } };
  const envelopes = [
    null,
    { kind: "rpc", context: {} },
    { kind: "collection", collection: "posts", operation: "patch", id: "p1", context: {} },
    { kind: "collection", collection: "posts", operation: "get", context: {} },
    {
      kind: "collection",
      collection: "posts",
      operation: "get",
      id: "p1",
      extra: true,
      context: {},
    },
  ];

  for (const body of envelopes) {
    const doResponse = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(doResponse.status).toBe(400);
    await expect(doResponse.json()).resolves.toMatchObject(badRequest);

    const workerResponse = await handler.request("http://fire.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(workerResponse.status).toBe(400);
    await expect(workerResponse.json()).resolves.toMatchObject(badRequest);
  }

  const malformedJsonResponse = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: "{",
    }),
  );
  expect(malformedJsonResponse.status).toBe(400);
  await expect(malformedJsonResponse.json()).resolves.toMatchObject(badRequest);
});

test("unknown collection and action names stay NOT_FOUND after decode", async () => {
  let object: DurableObject;
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
    stub: () => object as unknown as DurableObjectStub,
  });
  const handler = context
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );

  const notFound = { ok: false, error: { kind: "operation", code: "NOT_FOUND", status: 404 } };
  const request: WireRequest = {
    kind: "collection",
    collection: "ghosts",
    operation: "get",
    id: "g1",
    context: { tenantId: "tenant-a" },
  };
  const doResponse = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
  expect(doResponse.status).toBe(404);
  await expect(doResponse.json<WireResponse>()).resolves.toMatchObject(notFound);
});

test("runtime accessPolicy uses policy-package grant identity", async () => {
  expect(fullAccess).toBe(Policy.fullAccess);
  expect(none).toBe(Policy.none);
  expect(grant).toBe(Policy.grant);
  const runtimeGrant = grant("get", "list");
  const policyGrant = Policy.grant("get", "list");
  expect(Policy.allows(runtimeGrant, "get")).toBe(true);
  expect(Policy.allows(policyGrant, "get")).toBe(true);
  expect(Policy.permissionsOf(runtimeGrant)).toEqual(Policy.permissionsOf(policyGrant));
});

test("MISSING_STUB is thrown when production handle has no stub", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  const response = await handler.request("http://fire.test/posts/p1");
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "MISSING_STUB", status: 500 },
  });
});
