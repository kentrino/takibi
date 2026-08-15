import { expect, test } from "vite-plus/test";
import { z } from "zod";
import type { ActionDefinitions } from "../src/action";
import { createClient, fire, grant, none, read, write } from "../src/index";
import type { AccessContext } from "../src/index";
import type { WireRequest, WireResponse } from "../src/protocol";

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
  if (user?.role === "admin") return write;
  if (!user) return none;
  if (doc?.secret === true || nextDoc?.secret === true) return grant("list");
  return write;
}

function createActionApp() {
  const context = fire.initialContext()({ resolve: resolveTestContext });
  const staff = context.policy(({ user }) => (user ? write : none));

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

function createFakeDurableObjectStorage(): DurableObjectStorage {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      values.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return values.delete(key);
    },
    async list<T>(options?: {
      prefix?: string;
      limit?: number;
      startAfter?: string;
    }): Promise<Map<string, T>> {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ""))
        .filter(([key]) => (options?.startAfter ? key > options.startAfter : true))
        .sort(([left], [right]) => left.localeCompare(right));
      const limited = options?.limit === undefined ? entries : entries.slice(0, options.limit);
      return new Map(limited) as Map<string, T>;
    },
  } as unknown as DurableObjectStorage;
}

function createFakeDurableObjectState(storage: DurableObjectStorage): DurableObjectState {
  return {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

test("CRUD and collection/root actions roundtrip in memory mode", async () => {
  const { handler } = createActionApp();
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

  await handler.$collections.posts.add({ title: "source" }, { id: "p1" });
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
  const context = fire.initialContext()({
    resolve: () => ({
      tenantId: "tenant-a",
      user: { id: "u1" },
      permission: "application-admin" as const,
      scope: "application-scope" as const,
    }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: write } },
    { memory: true },
  );
  const inspect = base
    .defineAction()
    .policy(({ ctx, permission, scope }) =>
      ctx.permission === "application-admin" &&
      ctx.scope === "application-scope" &&
      permission === "invoke" &&
      scope.kind === "root"
        ? write
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

test("normal action CRUD enforces accessPolicy and $collection bypass is local", async () => {
  const { handler } = createActionApp();
  await handler.$collections.posts.add({ title: "secret", secret: true }, { id: "secret" });
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
    createFakeDurableObjectState(createFakeDurableObjectStorage()),
    {},
  );
  await object.$collections.posts.add({ title: "inside" }, { id: "p1" });

  const response = await object.fetch(
    new Request("https://fire.internal", {
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

test("Worker forwards only the action invocation and resolved context", async () => {
  let captured: unknown;
  const context = fire.initialContext()({
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
    posts: { schema: Post, accessPolicy: write },
  });
  const ping = base
    .defineAction()
    .policy(write)
    .handler(() => ({ pong: true }));
  const handler = base.actions({ ping });

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

test("action registration is atomic and validates collisions", async () => {
  const context = fire.initialContext()({
    resolve: () => ({ tenantId: "t", user: { id: "u", role: "admin" as const } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: write } },
    { memory: true },
  );
  const valid = base
    .defineAction()
    .policy(write)
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
      badPolicy: { ...valid, policy: new Set(["admin"]) } as never,
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
  const context = fire.initialContext()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  const invalid = context.defineCollection({
    schema: Post,
    accessPolicy: write,
    // @ts-expect-error CRUD action names are rejected by the public builder type
    actions: (defineAction) => ({
      get: defineAction()
        .policy(write)
        .handler(() => ({ bad: true })),
    }),
  });
  expect(() => context.collections({ posts: invalid })).toThrow(/reserved name/);

  expect(() =>
    context.collections({
      posts: {
        schema: Post,
        accessPolicy: write,
        actions: () => ({}),
      } as never,
    }),
  ).toThrow(/require defineCollection/);
});

test("collection registration rejects hidden, symbol, and inherited entries", () => {
  const context = fire.initialContext()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  const definition = { schema: Post, accessPolicy: write };
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
  const context = fire.initialContext()({
    resolve: () => ({ tenantId: "t", user: { id: "u" } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: write } },
    { memory: true },
  );
  const invalid = base
    .defineAction()
    .policy(write)
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
  const context = fire.initialContext()({
    resolve: () => ({ tenantId: "t", user: { id: "u" } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: write } },
    { memory: true },
  );
  const serialize = base
    .defineAction()
    .policy(write)
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
  const context = fire.initialContext()({
    resolve: () => ({ tenantId: "t", user: { id: "u" } }),
  });
  const base = context.collections(
    { posts: { schema: Post, accessPolicy: write } },
    { memory: true },
  );
  const invalidArray = base
    .defineAction()
    .policy(write)
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
    const context = fire.initialContext()({
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
      { posts: { schema: Post, accessPolicy: write } },
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
