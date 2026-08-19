import { expect, test } from "vite-plus/test";
import { z } from "zod";
import type { ActionDefinitions } from "../src/action";
import { executeOperation } from "../src/executor";
import {
  createClient,
  createTakibi,
  fullAccess,
  grant,
  none,
  queryImpliesEquality,
  read,
} from "../src/index";
import type { AccessContext, QueryExpr, StorageDriver } from "../src/types";
import type { WireRequest, WireResponse } from "../src/protocol";
import { createSqliteDurableObjectStorage } from "./sqlite";

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

  const posts = context.defineCollection({
    schema: Post,
    accessPolicy: postPolicy,
    actions: (defineAction) => ({
      duplicate: defineAction()
        .input(z.object({ id: z.string(), title: z.string().min(1) }))
        .policy(staff)
        .handler(async ({ input, collection, $collection, ctx }) => {
          const source = await $collection.get(input.id);
          return collection.add({
            title: `${input.title}:${ctx.user?.id ?? "none"}`,
            secret: source.secret,
          });
        }),
      stats: defineAction()
        .requires("list")
        .policy(read)
        .handler(async ({ collection }) => {
          const page = await collection.list();
          return { count: page.items.length };
        }),
      ping: defineAction()
        .policy(staff)
        .handler(() => ({ pong: true })),
      noContent: defineAction()
        .policy(staff)
        .handler(() => undefined),
      coerced: defineAction()
        .input(z.coerce.number())
        .policy(staff)
        .handler(({ input }) => ({ value: input })),
      readSecret: defineAction()
        .input(z.string())
        .policy(staff)
        .handler(({ input, collection }) => collection.get(input)),
      readSecretTrusted: defineAction()
        .input(z.string())
        .policy(staff)
        .handler(({ input, $collection }) => $collection.get(input)),
    }),
  });

  const base = context.collections({ posts }, { memory: true });
  const exportAll = base
    .defineAction()
    .policy(staff)
    .handler(async ({ ctx, collections }) => {
      const page = await collections.posts.list();
      return { by: ctx.user?.id ?? "none", titles: page.items.map((post) => post.title) };
    });
  const handler = base.actions({ exportAll });
  return { base, handler };
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

test("bounded array fields roundtrip through whole-document add, get, and update", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const handler = context.collections(
    {
      posts: {
        schema: z.object({
          title: z.string(),
          comments: z.array(z.object({ body: z.string() })),
        }),
        accessPolicy: fullAccess,
      },
    },
    { memory: true },
  );
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await client.posts.add(
    { title: "first", comments: [{ body: "hi" }] },
    { id: "p1" },
  );
  expect(created).toMatchObject({
    ok: true,
    data: { id: "p1", title: "first", comments: [{ body: "hi" }] },
  });

  const got = await client.posts.get("p1");
  expect(got).toMatchObject({
    ok: true,
    data: { id: "p1", comments: [{ body: "hi" }] },
  });

  const updated = await client.posts.update("p1", { comments: [{ body: "edited" }] });
  expect(updated).toMatchObject({
    ok: true,
    data: { id: "p1", title: "first", comments: [{ body: "edited" }] },
  });
});

test("CRUD and collection/root actions roundtrip in memory mode", async () => {
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

  const coerced = await client.posts.coerced("42");
  expect(coerced).toEqual({ ok: true, data: { value: 42 } });
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

test("action input is validated and client uses one-segment colon routes", async () => {
  const { handler } = createActionApp();
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const client = createClient<typeof handler>("http://fire.test/api/fire", {
    headers,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({
        method: request.method,
        url: request.url,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      const result = await handler.handle(request, { prefix: "/api/fire" });
      return result.response!;
    },
  });

  expect(await client.posts.add({ title: "source" }, { id: "p1" })).toMatchObject({
    ok: true,
    data: { id: "p1", title: "source" },
  });
  const duplicate = await client.posts.duplicate({ id: "p1", title: "copy" });
  expect(duplicate).toMatchObject({ ok: true, data: { title: "copy:u1" } });
  expect(calls.at(-1)).toEqual({
    method: "POST",
    url: "http://fire.test/api/fire/posts:duplicate",
    body: { id: "p1", title: "copy" },
  });

  await client.exportAll();
  expect(calls.at(-1)).toEqual({
    method: "POST",
    url: "http://fire.test/api/fire/$:exportAll",
  });

  const invalid = await client.posts.duplicate({ id: "p1", title: "" });
  expect(invalid).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
});

test("action input schema refinements become validation failures", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const RegisterInput = z
    .object({ email: z.string() })
    .refine((input) => !input.email.endsWith(".invalid"), {
      message: "blocked domain",
      path: ["email"],
    });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { memory: true },
  );
  const register = base
    .defineAction()
    .input(RegisterInput)
    .policy(fullAccess)
    .handler(({ input }) => ({ email: input.email }));
  const handler = base.actions({ register });
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });

  const blocked = await client.register({ email: "user@example.invalid" });
  expect(blocked).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  if (!blocked.ok && blocked.error.kind === "validation") {
    expect(blocked.error.issues.some((issue) => issue.message === "blocked domain")).toBe(true);
  }

  const ok = await client.register({ email: "user@example.com" });
  expect(ok).toEqual({ ok: true, data: { email: "user@example.com" } });
});

test("client compiles list callbacks to normalized HTTP query AST", async () => {
  const { handler } = createActionApp();
  let calls = 0;
  let capturedUrl = "";
  const client = createClient<typeof handler>("http://fire.test/api/fire", {
    fetch: (input) => {
      calls += 1;
      capturedUrl =
        input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      return Response.json({ ok: true, data: { items: [] } });
    },
  });
  let callbackCalls = 0;

  await client.posts.list({
    limit: 5,
    where: (query) => {
      callbackCalls += 1;
      return query.and(query.title.eq("hello"), query.createdAt.gte("2026-08-15T00:00:00.000Z"));
    },
  });

  expect(callbackCalls).toBe(1);
  expect(calls).toBe(1);
  const url = new URL(capturedUrl);
  expect(url.searchParams.get("limit")).toBe("5");
  expect(JSON.parse(url.searchParams.get("where")!)).toEqual({
    op: "and",
    operands: [
      { field: "title", op: "eq", value: "hello" },
      { field: "createdAt", op: "gte", value: "2026-08-15T00:00:00.000Z" },
    ],
  });
});

test("owner policy only grants list when the whole query implies the caller owner", async () => {
  const context = createTakibi()({
    resolve: resolveTestContext,
  });
  const Note = z.object({
    ownerId: z.string(),
    status: z.string(),
  });
  const handler = context.collections(
    {
      notes: {
        schema: Note,
        accessPolicy: context.policy(Note.pick({ ownerId: true }), ({ user, operation, where }) => {
          if (user?.role === "admin") return fullAccess;
          if (operation === "list" && user && queryImpliesEquality(where, "ownerId", user.id)) {
            return grant("list");
          }
          return none;
        }),
      },
    },
    { memory: true },
  );
  const admin = createClient<typeof handler>("http://fire.test", {
    headers: () => headers({ id: "admin", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });
  await admin.notes.add({ ownerId: "u1", status: "open" }, { id: "n1" });
  await admin.notes.add({ ownerId: "u2", status: "open" }, { id: "n2" });
  await admin.notes.add({ ownerId: "u1", status: "closed" }, { id: "n3" });
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });

  const own = await client.notes.list({
    where: (query) => query.ownerId.eq("u1"),
  });
  expect(own).toMatchObject({
    ok: true,
    data: { items: [{ id: "n1" }, { id: "n3" }] },
  });
  const ownOpen = await client.notes.list({
    where: (query) => query.and(query.ownerId.eq("u1"), query.status.eq("open")),
  });
  expect(ownOpen).toMatchObject({
    ok: true,
    data: { items: [{ id: "n1" }] },
  });

  for (const result of [
    await client.notes.list(),
    await client.notes.list({ where: (query) => query.ownerId.eq("u2") }),
    await client.notes.list({
      where: (query) => query.or(query.ownerId.eq("u1"), query.status.eq("open")),
    }),
    await client.notes.list({
      where: (query) => query.not(query.ownerId.eq("u2")),
    }),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", status: 403 },
    });
  }
});

test("list policy sees normalized where before storage access", async () => {
  const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
  let observed: QueryExpr | undefined;
  let listCalls = 0;
  const storage: StorageDriver = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {
      return false;
    },
    async list() {
      listCalls += 1;
      return { items: [] };
    },
    transaction(callback) {
      return callback(storage);
    },
  };

  await expect(
    executeOperation(
      {
        notes: {
          schema: z.object({ ownerId: z.string() }),
          accessPolicy(context) {
            observed = context.where;
            return none;
          },
        },
      },
      storage,
      { tenantId: "tenant-a", user: { id: "u1" } },
      {
        kind: "collection",
        collection: "notes",
        operation: "list",
        list: { where },
      },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });

  expect(observed).toEqual(where);
  expect(listCalls).toBe(0);
});

test("gate policy is mandatory at execution and requires can use list grants", async () => {
  const { handler } = createActionApp();
  const anonymous = clientFor(handler, null);

  expect(await anonymous.posts.ping()).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
  expect(await anonymous.posts.stats()).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
});

test("action gate keeps resolved context under ctx without claim collisions", async () => {
  const context = createTakibi()({
    resolve: () => ({
      tenantId: "tenant-a",
      user: { id: "u1" },
      permission: "application-admin" as const,
      scope: "application-scope" as const,
    }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { memory: true },
  );
  const inspect = base
    .defineAction()
    .policy(({ ctx, permission, scope }) =>
      ctx.permission === "application-admin" &&
      ctx.scope === "application-scope" &&
      permission === "invoke" &&
      scope.kind === "root"
        ? fullAccess
        : none,
    )
    .handler(({ ctx }) => ({ permission: ctx.permission, scope: ctx.scope }));
  const handler = base.actions({ inspect });
  const client = createClient<typeof handler>("http://fire.test", {
    fetch: (input, init) => handler.request(input, init),
  });

  expect(await client.inspect()).toEqual({
    ok: true,
    data: { permission: "application-admin", scope: "application-scope" },
  });
});

test("set policy denial conceals existence for new and existing ids", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const handler = context.collections(
    { posts: { schema: Post, accessPolicy: ({ user }) => (user ? fullAccess : none) } },
    { memory: true },
  );
  const admin = createClient<typeof handler>("http://fire.test", {
    headers: () => headers({ id: "admin", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });
  const guest = createClient<typeof handler>("http://fire.test", {
    headers: () => headers(null),
    fetch: (input, init) => handler.request(input, init),
  });

  expect(await admin.posts.add({ title: "kept" }, { id: "exists" })).toMatchObject({
    ok: true,
    data: { id: "exists", title: "kept" },
  });

  expect(await guest.posts.set("exists", { title: "changed" })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(await guest.posts.set("missing", { title: "created" })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(await guest.posts.add({ title: "add" })).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });

  expect(await admin.posts.get("exists")).toMatchObject({
    ok: true,
    data: { id: "exists", title: "kept" },
  });
  expect(await admin.posts.get("missing")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
});

test("normal action CRUD enforces accessPolicy and $collection bypass is local", async () => {
  const { handler } = createActionApp();
  const admin = clientFor(handler, { id: "admin", role: "admin" });
  await admin.posts.add({ title: "secret", secret: true }, { id: "secret" });
  const client = clientFor(handler);

  expect(await client.posts.readSecret("secret")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  expect(await client.posts.readSecretTrusted("secret")).toMatchObject({
    ok: true,
    data: { id: "secret", title: "secret", secret: true },
  });

  const duplicate = await client.posts.duplicate({ id: "secret", title: "copy" });
  expect(duplicate).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
});

test("actions execute inside the generated Durable Object", async () => {
  const { base, handler } = createActionApp();
  expect(base).toBe(handler);
  const object = new base.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await object.$collections.posts.add({ title: "inside" }, { id: "p1" });

  const response = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "action",
        scope: "$",
        name: "exportAll",
        context: {
          tenantId: "tenant-a",
          user: { id: "admin", role: "admin" },
        },
      } satisfies WireRequest),
    }),
  );
  expect(await response.json()).toEqual({
    ok: true,
    data: { by: "admin", titles: ["inside"] },
  });
});

test("named Durable Object fetch accepts a matching tenantId", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
  }).collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );

  const response = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "collection",
        collection: "posts",
        operation: "add",
        id: "p1",
        input: { title: "ok" },
        context: { tenantId: "tenant-a", user: { id: "u1", role: "member" } },
      } satisfies WireRequest),
    }),
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    data: { id: "p1", title: "ok" },
  });
});

test("named Durable Object fetch rejects a tenant mismatch before storage", async () => {
  let reads = 0;
  const storage = createSqliteDurableObjectStorage();
  const watched = {
    ...storage,
    async get(key: string) {
      reads += 1;
      return storage.get(key);
    },
    async list(options?: { prefix?: string; limit?: number; startAfter?: string }) {
      reads += 1;
      return storage.list(options);
    },
  } as DurableObjectStorage;
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
  }).collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const object = new handler.DurableObject(
    createFakeDurableObjectState(watched, { name: "tenant-a" }),
    {},
  );

  const response = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "collection",
        collection: "posts",
        operation: "add",
        id: "p1",
        input: { title: "cross-tenant" },
        context: { tenantId: "tenant-b", user: { id: "u1", role: "member" } },
      } satisfies WireRequest),
    }),
  );
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403, message: "Tenant mismatch" },
  });
  expect(reads).toBe(0);
});

test("named Durable Object fetch rejects an empty tenantId", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
  }).collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    {},
  );

  const response = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "collection",
        collection: "posts",
        operation: "get",
        id: "p1",
        context: { tenantId: "", user: { id: "u1", role: "member" } },
      } satisfies WireRequest),
    }),
  );
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
});

test("unnamed Durable Object fetch skips the tenant name check", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
  }).collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const unnamed = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  const emptyName = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "" }),
    {},
  );

  for (const object of [unnamed, emptyName]) {
    const response = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify({
          kind: "collection",
          collection: "posts",
          operation: "add",
          id: "p1",
          input: { title: "skipped" },
          context: { tenantId: "other", user: { id: "u1", role: "member" } },
        } satisfies WireRequest),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { id: "p1", title: "skipped" },
    });
  }
});

test("invalid wire envelopes are BAD_REQUEST on Worker and DO paths", async () => {
  let object: DurableObject;
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
    stub: () => object as unknown as DurableObjectStub,
  });
  const handler = context.collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
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
});

test("unknown collection and action names stay NOT_FOUND after decode", async () => {
  let object: DurableObject;
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
    stub: () => object as unknown as DurableObjectStub,
  });
  const handler = context.collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );

  const notFound = { ok: false, error: { kind: "operation", code: "NOT_FOUND", status: 404 } };
  const doCollection = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "collection",
        collection: "ghosts",
        operation: "get",
        id: "g1",
        context: { tenantId: "tenant-a", user: { id: "u1", role: "member" } },
      } satisfies WireRequest),
    }),
  );
  expect(doCollection.status).toBe(404);
  await expect(doCollection.json()).resolves.toMatchObject(notFound);

  const workerCollection = await handler.request("http://fire.test/ghosts/g1");
  expect(workerCollection.status).toBe(404);
  await expect(workerCollection.json()).resolves.toMatchObject(notFound);

  const doAction = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "action",
        scope: "$",
        name: "haunt",
        context: { tenantId: "tenant-a", user: { id: "u1", role: "member" } },
      } satisfies WireRequest),
    }),
  );
  expect(doAction.status).toBe(404);
  await expect(doAction.json()).resolves.toMatchObject(notFound);

  const workerAction = await handler.request("http://fire.test/$:haunt", { method: "POST" });
  expect(workerAction.status).toBe(404);
  await expect(workerAction.json()).resolves.toMatchObject(notFound);
});

test("Worker forwards only the action invocation and resolved context", async () => {
  let captured: unknown;
  const context = createTakibi()({
    resolve: () => ({
      tenantId: "trusted",
      user: { id: "u1", role: "admin" as const },
      traceId: "trace",
    }),
    stub: () =>
      ({
        fetch: async (request: Request) => {
          captured = await request.json();
          return Response.json({ ok: true, data: { pong: true } } satisfies WireResponse);
        },
      }) as DurableObjectStub,
  });
  const base = context.collections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const ping = base
    .defineAction()
    .atomic()
    .policy(fullAccess)
    .handler(() => ({ pong: true }));
  const handler = base.actions({ ping });
  expect(handler).not.toHaveProperty("$collections");

  const client = createClient<typeof handler>("http://fire.test", {
    fetch: (input, init) => handler.request(input, init),
  });
  expect(await client.ping()).toEqual({ ok: true, data: { pong: true } });
  expect(captured).toEqual({
    kind: "action",
    scope: "$",
    name: "ping",
    context: {
      tenantId: "trusted",
      user: { id: "u1", role: "admin" },
      traceId: "trace",
    },
  });
});

test("resolved context routes to a Durable Object and authorizes without tenantId or user", async () => {
  type ClinicContext = {
    clinic: { slug: string };
    actor: { id: string };
  };
  let routedContext: ClinicContext | undefined;
  let object: DurableObject;
  const context = createTakibi()({
    resolve: ({ request }): ClinicContext => ({
      clinic: { slug: request.headers.get("x-clinic") ?? "missing" },
      actor: { id: request.headers.get("x-actor") ?? "anonymous" },
    }),
    stub: ({ resolved }) => {
      routedContext = resolved;
      return object as unknown as DurableObjectStub;
    },
  });
  const handler = context.collections({
    posts: {
      schema: Post,
      accessPolicy: ({ clinic, actor }) =>
        clinic.slug === "clinic-a" && actor.id === "u1" ? fullAccess : none,
    },
  });
  object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  const client = createClient<typeof handler>("http://fire.test", {
    headers: { "x-clinic": "clinic-a", "x-actor": "u1" },
    fetch: (input, init) => handler.request(input, init),
  });

  await expect(client.posts.add({ title: "routed" }, { id: "p1" })).resolves.toMatchObject({
    ok: true,
    data: { id: "p1", title: "routed" },
  });
  expect(routedContext).toEqual({
    clinic: { slug: "clinic-a" },
    actor: { id: "u1" },
  });
});

test("action registration is atomic and validates collisions", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: { id: "u", role: "admin" as const } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { memory: true },
  );
  const valid = base
    .defineAction()
    .policy(fullAccess)
    .handler(() => ({ ok: true }));
  const invalid = { ...valid, kind: "collection" } as never;
  const register = (definitions: ActionDefinitions) => base.actions(definitions as never);

  expect(() => register({ valid, invalid })).toThrow(/Invalid root action/);
  const beforeCommit = await base.request("http://fire.test/$:valid", {
    method: "POST",
    headers: headers(),
  });
  expect(beforeCommit.status).toBe(404);

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
  register({ valid });
  expect(() => register({ valid })).toThrow(/already registered/);
});

test("collection action definitions reject CRUD names and require defineCollection", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  const invalid = context.defineCollection({
    schema: Post,
    accessPolicy: fullAccess,
    // @ts-expect-error CRUD action names are rejected by the public builder type
    actions: (defineAction) => ({
      get: defineAction()
        .policy(fullAccess)
        .handler(() => ({ bad: true })),
    }),
  });
  expect(() => context.collections({ posts: invalid })).toThrow(/reserved name/);

  expect(() =>
    context.collections({
      posts: {
        schema: Post,
        accessPolicy: fullAccess,
        actions: () => ({}),
      } as never,
    }),
  ).toThrow(/require defineCollection/);
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

  expect(() => context.collections(hidden as never)).toThrow(/enumerable data properties/);
  expect(() => context.collections({ [Symbol("posts")]: definition } as never)).toThrow(
    /names must be strings/,
  );
  expect(() => context.collections(Object.create({ posts: definition }) as never)).toThrow(
    /plain object/,
  );
});

test("client reflection properties never become network endpoints", async () => {
  let calls = 0;
  const { handler } = createActionApp();
  const client = createClient<typeof handler>("http://fire.test", {
    fetch: () => {
      calls += 1;
      return Response.json({ ok: true, data: null });
    },
  });

  expect(JSON.stringify(client)).toBe("{}");
  await expect(Promise.resolve(client)).resolves.toBe(client);
  expect(Reflect.get(client, "__proto__")).toBeUndefined();
  expect(Reflect.get(client.posts, "constructor")).toBeUndefined();
  expect(Reflect.get(client.posts, "bind")).toBeUndefined();
  expect(calls).toBe(0);
});

test("non-JSON action output is rejected before the success envelope", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: { id: "u" } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { memory: true },
  );
  const invalid = base
    .defineAction()
    .policy(fullAccess)
    .handler((() => new Date()) as never);
  const handler = base.actions({ invalid });
  const response = await handler.request("http://fire.test/$:invalid", {
    method: "POST",
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_ACTION_OUTPUT" },
  });
});

test("custom serialization hooks are rejected from action output", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: { id: "u" } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { memory: true },
  );
  const serialize = base
    .defineAction()
    .policy(fullAccess)
    .handler(() => {
      const output = { safe: true };
      Object.defineProperty(output, "toJSON", {
        value: () => ({ safe: false }),
        enumerable: false,
      });
      return output;
    });
  const handler = base.actions({ serialize });
  const response = await handler.request("http://fire.test/$:serialize", {
    method: "POST",
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_ACTION_OUTPUT" },
  });
});

test("client rejects non-JSON action input before fetch", async () => {
  let calls = 0;
  const { handler } = createActionApp();
  const client = createClient<typeof handler>("http://fire.test", {
    fetch: () => {
      calls += 1;
      return Response.json({ ok: true, data: null });
    },
  });

  await expect(
    (client.posts.duplicate as (input: unknown) => Promise<unknown>)({
      id: "p1",
      title: new Date(),
    }),
  ).rejects.toThrow(/JSON/);
  const array = ["p1", "copy"];
  Object.defineProperty(array, "toJSON", {
    value: () => ({ id: "p1", title: "copy" }),
    enumerable: false,
  });
  await expect(
    (client.posts.duplicate as (input: unknown) => Promise<unknown>)(array),
  ).rejects.toThrow(/custom properties/);
  expect(calls).toBe(0);
});

test("action output arrays reject ignored custom and accessor properties", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: { id: "u" } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: fullAccess } },
    { memory: true },
  );
  const invalidArray = base
    .defineAction()
    .policy(fullAccess)
    .handler(() => {
      const output = [1, 2];
      Object.defineProperty(output, "3", {
        get: () => 3,
        enumerable: true,
      });
      return output;
    });
  const handler = base.actions({ invalidArray });
  const response = await handler.request("http://fire.test/$:invalidArray", {
    method: "POST",
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_ACTION_OUTPUT" },
  });
});

test("non-JSON resolved context is rejected equally before memory or DO dispatch", async () => {
  let stubCalls = 0;
  const create = (memory: boolean) => {
    const context = createTakibi()({
      resolve: () => ({
        tenantId: "tenant-a",
        user: { id: "u1" },
        now: new Date(),
      }),
      stub: () => {
        stubCalls += 1;
        return {
          fetch: () => Response.json({ ok: true, data: null }),
        } as unknown as DurableObjectStub;
      },
    });
    return context.collections(
      { posts: { schema: Post, accessPolicy: fullAccess } },
      memory ? { memory: true } : undefined,
    );
  };

  for (const handler of [create(true), create(false)]) {
    const response = await handler.request("http://fire.test/posts");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_CONTEXT" },
    });
  }
  expect(stubCalls).toBe(0);
});
