import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import type { ActionDefinitions } from "../src/action";
import { executeOperation } from "../src/executor";
import { createClient } from "@takibi/takibi/client";
import { withSqliteTestBackend } from "@takibi/takibi/testing";
import {
  createTakibi,
  fullAccess,
  grant,
  none,
  queryImpliesEquality,
  read,
  UnauthorizedError,
} from "../src/index";
import type { AccessContext, QueryExpr, StorageDriver } from "../src/types";
import type { WireRequest, WireResponse } from "../src/protocol";
import { createSqliteDurableObjectStorage } from "../src/testing/sqlite-storage.server";
import { MaintenanceController } from "../src/maintenance";
import { createDurableObjectStorage } from "../src/storage";

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
    // Document action gated by a schema-bound policy: secret docs deny invoke.
    duplicate: defineAction()
      .input(z.object({ title: z.string().min(1) }))
      .policy(postGate)
      .handler(({ input, doc, collection, ctx }) =>
        collection.add({
          title: `${input.title}:${ctx.user?.id ?? "none"}`,
          secret: doc.secret,
        }),
      ),
    // Document action writing to another collection via $collections.
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
      .policy(read)
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
    readSecret: defineAction()
      .policy(staff)
      .handler(({ id, collection }) => collection.get(id)),
    readSecretTrusted: defineAction()
      .policy(staff)
      .handler(({ doc }) => doc),
  }));

  const exportAll = app
    .defineAction()
    .policy(staff)
    .handler(async ({ ctx, collections }) => {
      const page = await collections.posts.list();
      return { by: ctx.user?.id ?? "none", titles: page.items.map((post) => post.title) };
    });
  const coerced = app
    .defineAction()
    .input(z.coerce.number())
    .policy(staff)
    .handler(({ input }) => ({ value: input }));
  const handler = withSqliteTestBackend(
    app.actions({ $: { exportAll, coerced }, posts: postsActions }),
  );
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

test("bounded array fields roundtrip through whole-document add, get, and update", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const production = context
    .defineCollections({
      posts: {
        schema: z.object({
          title: z.string(),
          comments: z.array(z.object({ body: z.string() })),
        }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
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

  const coerced = await client.coerced("42");
  expect(coerced).toEqual({ ok: true, data: { value: 42 } });
});

test("document actions read and write other collections through $collections", async () => {
  const { handler } = createActionApp();
  const client = clientFor(handler);

  await client.posts.add({ title: "first" }, { id: "p1" });
  const audited = await client.posts.audited("p1");
  expect(audited).toEqual({ ok: true, data: { audits: 1 } });
});

test("document actions reuse a schema-bound accessPolicy as a doc-aware gate", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const directory = context.policy(Post, ({ user, doc }) =>
    user && doc?.secret !== true ? fullAccess : none,
  );
  const posts = context.defineCollection({
    schema: Post,
    accessPolicy: fullAccess,
    seed: () => ({
      open: { title: "open", secret: false },
      hidden: { title: "hidden", secret: true },
    }),
  });
  const app = context.defineCollections({ posts });
  const postsActions = app.posts.actions((defineAction) => ({
    touch: defineAction()
      .policy(directory)
      .handler(({ id }) => ({ touched: id })),
  }));
  const handler = withSqliteTestBackend(app.actions({ posts: postsActions }));
  const member = createClient<typeof handler>("http://fire.test", {
    headers: () => headers({ id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });
  expect(await member.posts.touch("open")).toEqual({ ok: true, data: { touched: "open" } });
  expect(await member.posts.touch("hidden")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
  expect(await member.posts.touch("missing")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });

  const denied = createClient<typeof handler>("http://fire.test", {
    headers: () => headers(null),
    fetch: (input, init) => handler.request(input, init),
  });
  expect(await denied.posts.touch("open")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
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

test("named unique constraints cover public and trusted writes atomically", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const records = context.defineCollection({
    schema: z.object({
      key: z.string(),
      ownerId: z.string(),
      externalId: z.string().nullable().optional(),
    }),
    accessPolicy: fullAccess,
    unique: {
      byKey: ["key"],
      byOwnerExternalId: ["ownerId", "externalId"],
    },
  });
  const app = context.defineCollections({ records });
  const trustedCreate = app.records.actions((defineAction) => ({
    trustedCreate: defineAction()
      .detached()
      .input(z.object({ key: z.string(), ownerId: z.string() }))
      .policy(fullAccess)
      .handler(({ input, $collection }) => $collection.add(input)),
  }));
  const handler = withSqliteTestBackend(app.actions({ records: trustedCreate }));
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });

  expect(
    await client.records.add(
      { key: "first", ownerId: "owner", externalId: "external" },
      { id: "r1" },
    ),
  ).toMatchObject({ ok: true });
  expect(
    await client.records.set("r1", {
      key: "first",
      ownerId: "owner",
      externalId: "external",
    }),
  ).toMatchObject({ ok: true });
  expect(
    await client.records.add(
      { key: "second", ownerId: "owner", externalId: "external" },
      { id: "r2" },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: "ALREADY_EXISTS",
      message: "Unique constraint violated: records.byOwnerExternalId",
      status: 409,
    },
  });
  expect(
    await client.records.add(
      { key: "third", ownerId: "other", externalId: "external" },
      { id: "r3" },
    ),
  ).toMatchObject({ ok: true });
  expect(await client.records.update("r3", { key: "first" })).toMatchObject({
    ok: false,
    error: { code: "ALREADY_EXISTS", message: "Unique constraint violated: records.byKey" },
  });
  expect(await client.records.trustedCreate({ key: "first", ownerId: "trusted" })).toMatchObject({
    ok: false,
    error: { code: "ALREADY_EXISTS", message: "Unique constraint violated: records.byKey" },
  });

  expect(
    await client.records.add(
      { key: "null-1", ownerId: "owner", externalId: null },
      { id: "null-1" },
    ),
  ).toMatchObject({ ok: true });
  expect(
    await client.records.add({ key: "null-2", ownerId: "owner" }, { id: "null-2" }),
  ).toMatchObject({ ok: true });
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

test("action input is validated and client routes document actions by id", async () => {
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
  const duplicate = await client.posts.duplicate("p1", { title: "copy" });
  expect(duplicate).toMatchObject({ ok: true, data: { title: "copy:u1" } });
  expect(calls.at(-1)).toEqual({
    method: "POST",
    url: "http://fire.test/api/fire/posts/p1:duplicate",
    body: { title: "copy" },
  });

  const detached = await client.posts.stats();
  expect(detached).toMatchObject({ ok: true });
  expect(calls.at(-1)).toEqual({
    method: "POST",
    url: "http://fire.test/api/fire/posts:stats",
  });

  await client.exportAll();
  expect(calls.at(-1)).toEqual({
    method: "POST",
    url: "http://fire.test/api/fire/$:exportAll",
  });

  const invalid = await client.posts.duplicate("p1", { title: "" });
  expect(invalid).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });

  const emptyId = await client.posts.duplicate("", { title: "copy" });
  expect(emptyId).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
});

test("document action ids containing colons roundtrip as %3A on the wire", async () => {
  const { handler } = createActionApp();
  const calls: string[] = [];
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.url);
      return handler.request(request, init);
    },
  });

  await client.posts.add({ title: "colon" }, { id: "a:b" });
  const audited = await client.posts.audited("a:b");
  expect(audited).toEqual({ ok: true, data: { audits: 1 } });
  expect(calls.at(-1)).toBe("http://fire.test/posts/a%3Ab:audited");
});

test("no-input document actions accept a zero-length POST body", async () => {
  const { handler } = createActionApp();
  const created = await handler.request("http://fire.test/posts/p1", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ title: "first" }),
  });
  expect(created.status).toBe(200);

  const result = await handler.handle(
    new Request("http://fire.test/api/fire/posts/p1:audited", {
      method: "POST",
      headers: headers(),
      body: new Uint8Array(),
    }),
    { prefix: "/api/fire" },
  );
  expect(result.matched).toBe(true);
  expect(result.response?.status).toBe(200);
  await expect(result.response!.json()).resolves.toEqual({
    ok: true,
    data: { audits: 1 },
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
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const register = app
    .defineAction()
    .input(RegisterInput)
    .policy(fullAccess)
    .handler(({ input }) => ({ email: input.email }));
  const handler = withSqliteTestBackend(app.actions({ $: { register } }));
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

  expect(() =>
    client.posts.list({
      where: (query) => query.title.in([]),
    }),
  ).toThrow(/between 1 and 32/);
  expect(() =>
    client.posts.list({
      where: (query) => query.title.in(Array.from({ length: 33 }, (_, index) => `title-${index}`)),
    }),
  ).toThrow(/between 1 and 32/);
  expect(calls).toBe(1);
});

test("owner policy only grants list when the whole query implies the caller owner", async () => {
  const context = createTakibi()({
    resolve: resolveTestContext,
  });
  const Note = z.object({
    ownerId: z.string(),
    status: z.string(),
  });
  const production = context
    .defineCollections({
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
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
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

test("count uses list permission and follows every storage page", async () => {
  let observed: Pick<AccessContext<object>, "operation" | "permission" | "where"> | undefined;
  let listCalls = 0;
  const where: QueryExpr = { field: "ownerId", op: "eq", value: "u1" };
  const storage: StorageDriver = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {
      return false;
    },
    async list(_collection, options) {
      listCalls += 1;
      return options?.cursor
        ? { items: [{ id: "c", createdAt: "", updatedAt: "", rev: 1 }] }
        : {
            items: [
              { id: "a", createdAt: "", updatedAt: "", rev: 1 },
              { id: "b", createdAt: "", updatedAt: "", rev: 1 },
            ],
            nextCursor: "next",
          };
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
            observed = context;
            return read;
          },
        },
      },
      storage,
      {},
      {
        kind: "collection",
        collection: "notes",
        operation: "count",
        list: { where },
      },
    ),
  ).resolves.toBe(3);
  expect(observed).toMatchObject({ operation: "count", permission: "list", where });
  expect(listCalls).toBe(2);
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
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const inspect = app
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
  const handler = withSqliteTestBackend(app.actions({ $: { inspect } }));
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
  const production = context
    .defineCollections({
      posts: { schema: Post, accessPolicy: ({ user }) => (user ? fullAccess : none) },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
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

test("normal action CRUD enforces accessPolicy and trusted doc access is local", async () => {
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

  const duplicate = await client.posts.duplicate("secret", { title: "copy" });
  expect(duplicate).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", status: 403 },
  });
});

test("actions execute inside the generated Durable Object", async () => {
  const { handler } = createActionApp();
  const object = new handler.DurableObject(
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

test("trusted transaction commits and rolls back transaction-bound collections", async () => {
  const { handler } = createActionApp();
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  expect("$transaction" in object).toBe(false);
  expect("transaction" in object).toBe(false);
  expect("$transaction" in object.$collections).toBe(true);

  const committed = await object.$collections.$transaction(async ($collections) => {
    await $collections.posts.add({ title: "committed" }, { id: "committed-post" });
    await $collections.audits.add({ action: "committed" }, { id: "committed-audit" });
    return "done";
  });
  expect(committed).toBe("done");
  await expect(object.$collections.posts.get("committed-post")).resolves.toMatchObject({
    title: "committed",
  });
  await expect(object.$collections.audits.get("committed-audit")).resolves.toMatchObject({
    action: "committed",
  });

  await expect(
    object.$collections.posts.add(
      { title: "imported" },
      {
        id: "imported-post",
        createdAt: "2024-01-02T03:04:05.000Z",
        updatedAt: "2024-02-03T04:05:06.000Z",
      },
    ),
  ).resolves.toMatchObject({
    createdAt: "2024-01-02T03:04:05.000Z",
    updatedAt: "2024-02-03T04:05:06.000Z",
  });

  await expect(
    object.$collections.$transaction(async ($collections) => {
      await $collections.posts.add({ title: "rolled back" }, { id: "rolled-back-post" });
      await $collections.$transaction(async (nested) => {
        await nested.audits.add({ action: "rolled back" }, { id: "rolled-back-audit" });
      });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await expect(object.$collections.posts.get("rolled-back-post")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(object.$collections.audits.get("rolled-back-audit")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("trusted count and conditional writes are atomic and schema-checked", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "conditional-writes" }) });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({
          group: z.string(),
          value: z.string(),
          counter: z.number().nullable().optional(),
          marked: z.boolean().default(false),
        }),
        accessPolicy: fullAccess,
        unique: { byValue: ["value"] },
        indexes: { byGroup: ["group"] },
      },
      audits: {
        schema: z.object({ action: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  const records = object.$collections.records;
  await records.add({ group: "a", value: "one", counter: 1 }, { id: "r1" });
  await records.add({ group: "a", value: "two", counter: null }, { id: "r2" });
  await records.add({ group: "b", value: "three" }, { id: "r3" });

  await expect(
    records.count({
      index: "byGroup",
      where: (query) => query.group.eq("a"),
    }),
  ).resolves.toBe(2);
  await expect(
    records.updateMany(
      { marked: true },
      { index: "byGroup", where: (query) => query.group.eq("a") },
    ),
  ).resolves.toEqual({ updated: 2 });
  await expect(
    records.incrementOne(
      { counter: 2 },
      { where: (query) => query.id.eq("r2"), set: { marked: false } },
    ),
  ).resolves.toMatchObject({ id: "r2", counter: 2, marked: false });

  await expect(
    records.updateMany({ value: "duplicate" }, { where: (query) => query.group.eq("a") }),
  ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  await expect(records.get("r1")).resolves.toMatchObject({ value: "one" });
  await expect(records.get("r2")).resolves.toMatchObject({ value: "two" });

  await expect(
    object.$collections.$transaction(async ($collections) => {
      await $collections.audits.add({ action: "rollback" }, { id: "rollback" });
      await $collections.records.updateMany(
        { marked: false },
        { where: (query) => query.group.eq("a") },
      );
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await expect(object.$collections.audits.get("rollback")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(records.get("r1")).resolves.toMatchObject({ marked: true });

  await expect(
    records.consumeOne({
      index: "byGroup",
      where: (query) => query.group.eq("a"),
    }),
  ).resolves.toMatchObject({ id: "r1" });
  await expect(records.deleteMany({ where: (query) => query.group.eq("a") })).resolves.toEqual({
    deleted: 1,
  });
  await expect(
    records.consumeOne({ where: (query) => query.group.eq("missing") }),
  ).resolves.toBeNull();
  await expect(
    records.incrementOne({ counter: 1 }, { where: (query) => query.id.eq("missing") }),
  ).resolves.toBeNull();
  await expect(records.updateMany({ marked: true }, {} as never)).rejects.toThrow(/require where/);
});

test("owner snapshot round-trips metadata and reset restores collection seeds", async () => {
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await object.$collections.posts.add({ title: "temporary", secret: false }, { id: "temporary" });
  await object.$collections.posts.update("temporary", { title: "snapshot", rev: 1 });

  expect("$exportSnapshot" in object).toBe(false);
  expect("$restoreSnapshot" in object).toBe(false);
  expect("$resetAll" in object).toBe(false);
  expect(Object.keys(object.$collections)).not.toContain("$exportSnapshot");
  await object.$collections.$transaction(async ($collections) => {
    expect("$exportSnapshot" in $collections).toBe(false);
    expect("$restoreSnapshot" in $collections).toBe(false);
    expect("$resetAll" in $collections).toBe(false);
  });
  const snapshot = await object.$collections.$exportSnapshot();
  const encoded = await new Response(snapshot).text();
  const records = encoded
    .trimEnd()
    .split("\n")
    .map((record) => JSON.parse(record) as Record<string, unknown>);
  const repeated = await new Response(await object.$collections.$exportSnapshot()).text();
  expect(repeated).toBe(encoded);
  expect(records[0]).toEqual({
    type: "header",
    format: "takibi.logical-snapshot",
    version: 1,
    collections: [{ name: "posts", schemaVersion: 0 }],
  });
  expect(records.at(-1)).toMatchObject({
    type: "trailer",
    counts: { posts: 2 },
  });
  expect(records.filter((record) => record.type === "document").map((record) => record.id)).toEqual(
    ["seeded", "temporary"],
  );

  expect("$resetStorage" in object).toBe(false);
  expect("$resetAll" in object).toBe(false);
  await object.$collections.$resetAll();

  await expect(object.$collections.posts.listAll()).resolves.toMatchObject([
    {
      id: "seeded",
      title: "from-seed",
    },
  ]);

  const report = await object.$collections.$restoreSnapshot(
    new Blob([encoded]).stream() as ReadableStream<Uint8Array>,
  );
  expect(report).toEqual({
    formatVersion: 1,
    documentsRestored: 2,
    seedsInserted: 0,
    collections: {
      posts: {
        documentsRestored: 2,
        seedsInserted: 0,
      },
    },
  });
  await expect(object.$collections.posts.get("temporary")).resolves.toMatchObject({
    title: "snapshot",
    rev: 2,
  });
  await expect(
    object.$collections.posts.update("temporary", { title: "continued", rev: 2 }),
  ).resolves.toMatchObject({
    title: "continued",
    rev: 3,
  });
});

test("owner snapshot lease blocks normal operations until completion or cancellation", async () => {
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await object.$collections.posts.get("seeded");

  const snapshot = await object.$collections.$exportSnapshot();
  await expect(object.$collections.posts.get("seeded")).rejects.toMatchObject({
    code: "MAINTENANCE_LOCKED",
    status: 503,
  });
  await expect(object.$collections.$transaction(async () => "unreachable")).rejects.toMatchObject({
    code: "MAINTENANCE_LOCKED",
  });
  const actionResponse = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "action",
        scope: "posts",
        name: "ping",
        context: {
          tenantId: "tenant-a",
          user: { id: "admin", role: "admin" },
        },
      } satisfies WireRequest),
    }),
  );
  expect(actionResponse.status).toBe(503);
  await expect(actionResponse.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "MAINTENANCE_LOCKED" },
  });
  await snapshot.cancel();
  await expect(object.$collections.posts.get("seeded")).resolves.toMatchObject({
    id: "seeded",
  });
});

test("maintenance admission drains an active action and rejects newer operations", async () => {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = createTakibi()({ resolve: () => ({ tenantId: "drain" }) });
  const app = context.defineCollections({
    records: {
      schema: z.object({ value: z.string() }),
      accessPolicy: fullAccess,
    },
  });
  const wait = app
    .defineAction()
    .policy(fullAccess)
    .handler(async ({ $collections }) => {
      entered();
      await releasePromise;
      await $collections.records.add({ value: "after-wait" }, { id: "completed" });
      return { done: true };
    });
  const handler = app.actions({ $: { wait } });
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  const action = object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "action",
        scope: "$",
        name: "wait",
        context: { tenantId: "drain" },
      } satisfies WireRequest),
    }),
  );
  await enteredPromise;

  const exportPromise = object.$collections.$exportSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(object.$collections.records.list()).rejects.toMatchObject({
    code: "MAINTENANCE_LOCKED",
  });
  release();
  await expect(Promise.resolve(action).then((response) => response.status)).resolves.toBe(200);
  const snapshot = await exportPromise;
  await snapshot.cancel();
  await expect(object.$collections.records.get("completed")).resolves.toMatchObject({
    value: "after-wait",
  });
});

test("maintenance drains trusted add after async schema validation starts", async () => {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = createTakibi()({ resolve: () => ({ tenantId: "trusted-drain" }) });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({
          value: z.string().transform(async (value) => {
            entered();
            await releasePromise;
            return value;
          }),
        }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );

  const addition = object.$collections.records.add({ value: "validated" }, { id: "completed" });
  await enteredPromise;
  const exportPromise = object.$collections.$exportSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(object.$collections.records.list()).rejects.toMatchObject({
    code: "MAINTENANCE_LOCKED",
  });
  release();
  await expect(addition).resolves.toMatchObject({ value: "validated" });
  const snapshot = await exportPromise;
  await snapshot.cancel();
  await expect(object.$collections.records.get("completed")).resolves.toBeDefined();
});

test("owner reset keeps normal operations locked while seeds are prepared", async () => {
  let seedCalls = 0;
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = createTakibi()({ resolve: () => ({ tenantId: "reset-lock" }) });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({ value: z.string() }),
        accessPolicy: fullAccess,
        seed: async () => {
          seedCalls += 1;
          if (seedCalls > 1) {
            entered();
            await releasePromise;
          }
          return { seed: { value: "seed" } };
        },
      },
    })
    .actions({});
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await object.$collections.records.get("seed");

  const reset = object.$collections.$resetAll();
  await enteredPromise;
  await expect(object.$collections.records.get("seed")).rejects.toMatchObject({
    code: "MAINTENANCE_LOCKED",
  });
  release();
  await expect(reset).resolves.toBeUndefined();
  await expect(object.$collections.records.get("seed")).resolves.toBeDefined();
});

test("normal collection operations use the in-memory gate without querying the lease table", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.posts.get("seeded");
  const exec = backing.sql.exec.bind(backing.sql);
  let leaseReads = 0;
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (query.includes("takibi_maintenance_lease")) leaseReads += 1;
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  await object.$collections.posts.get("seeded");
  await object.$collections.posts.list();

  expect(leaseReads).toBe(0);
});

test("expired export cannot complete or release a successor maintenance lease", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.posts.add({ title: "snapshot", secret: false }, { id: "p1" });
  const reader = (await object.$collections.$exportSnapshot()).getReader();
  const partial: Uint8Array[] = [];
  partial.push((await reader.read()).value!);
  partial.push((await reader.read()).value!);
  backing.sql.exec("UPDATE takibi_maintenance_lease SET expires_at = 0");

  const successor = new MaintenanceController(backing);
  const successorLease = await successor.acquire("reset");
  await expect(async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      partial.push(result.value);
    }
  }).rejects.toMatchObject({ code: "MAINTENANCE_LOCKED" });

  const partialText = await new Blob(partial).text();
  expect(partialText).not.toContain('"type":"trailer"');
  expect(
    backing.sql
      .exec<{ owner_token: string }>(
        "SELECT owner_token FROM takibi_maintenance_lease WHERE lease_key = ?",
        "global",
      )
      .one().owner_token,
  ).toBe(successorLease.token);
  await successor.release(successorLease);
  await expect(object.$collections.posts.get("p1")).resolves.toBeDefined();
});

test("Durable Object activation clears abandoned maintenance and restore staging", async () => {
  const backing = createSqliteDurableObjectStorage();
  createDurableObjectStorage(backing);
  const first = new MaintenanceController(backing);
  const lease = await first.acquire("restore");
  await first.backend.stageDocument(lease.token, {
    collection: "posts",
    id: "abandoned",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 1,
    data: { title: "abandoned", secret: false },
  });

  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await expect(object.$collections.posts.get("seeded")).resolves.toBeDefined();
  expect(
    backing.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM takibi_maintenance_lease")
      .one().count,
  ).toBe(0);
  expect(
    backing.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM takibi_restore_staging_documents")
      .one().count,
  ).toBe(0);
});

test("invalid snapshot leaves live documents unchanged and releases its lease", async () => {
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  const encoded = await new Response(await object.$collections.$exportSnapshot()).text();
  await object.$collections.posts.add({ title: "live", secret: false }, { id: "live" });
  const corrupted = encoded.replace("from-seed", "tampered");

  await expect(
    object.$collections.$restoreSnapshot(
      new Blob([corrupted]).stream() as ReadableStream<Uint8Array>,
    ),
  ).rejects.toMatchObject({ code: "SNAPSHOT_FORMAT" });
  await expect(object.$collections.posts.get("live")).resolves.toMatchObject({
    title: "live",
  });
});

test("restore rolls back the live replacement when staged insertion fails", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  const encoded = await new Response(await object.$collections.$exportSnapshot()).text();
  await object.$collections.posts.add({ title: "live", secret: false }, { id: "live" });
  const exec = backing.sql.exec.bind(backing.sql);
  let injected = false;
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (
      !injected &&
      query.includes("INSERT INTO takibi_documents") &&
      query.includes("FROM takibi_restore_staging_documents")
    ) {
      injected = true;
      throw new Error("injected restore failure");
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  await expect(
    object.$collections.$restoreSnapshot(
      new Blob([encoded]).stream() as ReadableStream<Uint8Array>,
    ),
  ).rejects.toThrow("injected restore failure");
  expect(injected).toBe(true);
  await expect(object.$collections.posts.get("live")).resolves.toMatchObject({
    title: "live",
  });
  await expect(object.$collections.posts.get("seeded")).resolves.toMatchObject({
    title: "from-seed",
  });
});

test("restore rolls back when atomic lease finalization fails", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  const encoded = await new Response(await object.$collections.$exportSnapshot()).text();
  await object.$collections.posts.add({ title: "live", secret: false }, { id: "live" });
  const exec = backing.sql.exec.bind(backing.sql);
  let injected = false;
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (!injected && query.includes("DELETE FROM takibi_maintenance_lease")) {
      injected = true;
      throw new Error("injected finalization failure");
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  await expect(
    object.$collections.$restoreSnapshot(
      new Blob([encoded]).stream() as ReadableStream<Uint8Array>,
    ),
  ).rejects.toThrow("injected finalization failure");
  await expect(object.$collections.posts.get("live")).resolves.toMatchObject({
    title: "live",
  });
});

test("owner reset preserves storage not managed by Takibi", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.posts.add({ title: "temporary", secret: false }, { id: "temporary" });
  backing.sql.exec("CREATE TABLE application_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  backing.sql.exec(
    "INSERT INTO application_state (key, value) VALUES (?, ?)",
    "marker",
    "preserved",
  );

  await object.$collections.$resetAll();

  expect(
    backing.sql
      .exec<{ value: string }>("SELECT value FROM application_state WHERE key = ?", "marker")
      .one().value,
  ).toBe("preserved");
  await expect(object.$collections.posts.get("temporary")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("owner reset rolls back when seed insertion fails", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.posts.add({ title: "live", secret: false }, { id: "live" });
  const exec = backing.sql.exec.bind(backing.sql);
  let injected = false;
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (!injected && query.includes("INSERT OR IGNORE INTO takibi_documents")) {
      injected = true;
      throw new Error("injected reset failure");
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  await expect(object.$collections.$resetAll()).rejects.toThrow("injected reset failure");
  await expect(object.$collections.posts.get("live")).resolves.toMatchObject({
    title: "live",
  });
});

test("owner reset rolls back when atomic lease finalization fails", async () => {
  const backing = createSqliteDurableObjectStorage();
  const handler = createProductionPostsHandler();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.posts.add({ title: "live", secret: false }, { id: "live" });
  const exec = backing.sql.exec.bind(backing.sql);
  let injected = false;
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (!injected && query.includes("DELETE FROM takibi_maintenance_lease")) {
      injected = true;
      throw new Error("injected reset finalization failure");
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  await expect(object.$collections.$resetAll()).rejects.toThrow(
    "injected reset finalization failure",
  );
  await expect(object.$collections.posts.get("live")).resolves.toMatchObject({
    title: "live",
  });
});

test("wire id is required for document actions and rejected elsewhere", async () => {
  const { handler } = createActionApp();
  const object = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await object.$collections.posts.add({ title: "target" }, { id: "p1" });
  const context = { tenantId: "tenant-a", user: { id: "u1", role: "member" } };
  const send = async (body: WireRequest) => {
    const response = await object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as unknown };
  };

  const documentOk = await send({
    kind: "action",
    scope: "posts",
    name: "audited",
    id: "p1",
    context,
  });
  expect(documentOk).toMatchObject({ status: 200, body: { ok: true, data: { audits: 1 } } });

  const missingId = await send({ kind: "action", scope: "posts", name: "audited", context });
  expect(missingId).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "BAD_REQUEST" } },
  });

  const detachedWithId = await send({
    kind: "action",
    scope: "posts",
    name: "ping",
    id: "p1",
    context,
  });
  expect(detachedWithId).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "BAD_REQUEST" } },
  });

  const rootWithId = await send({
    kind: "action",
    scope: "$",
    name: "exportAll",
    id: "p1",
    context,
  });
  expect(rootWithId).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "BAD_REQUEST" } },
  });

  const emptyId = await send({
    kind: "action",
    scope: "posts",
    name: "audited",
    id: "",
    context,
  } as never);
  expect(emptyId).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "BAD_REQUEST" } },
  });
});

test("named Durable Object fetch accepts a matching tenantId", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
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
  } as unknown as DurableObjectStorage;
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a", user: { id: "u1", role: "member" as const } }),
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
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
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
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
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
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
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const ping = app
    .defineAction()
    .atomic()
    .policy(fullAccess)
    .handler(() => ({ pong: true }));
  const handler = app.actions({ $: { ping } });
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
  const handler = context
    .defineCollections({
      posts: {
        schema: Post,
        accessPolicy: ({ clinic, actor }) =>
          clinic.slug === "clinic-a" && actor.id === "u1" ? fullAccess : none,
      },
    })
    .actions({});
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

test("action registration validates definitions", async () => {
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

test("scoped action maps are rejected when registered under another collection", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  const posts = context.defineCollection({ schema: Post, accessPolicy: fullAccess });
  const audits = context.defineCollection({
    schema: z.object({ action: z.string() }),
    accessPolicy: fullAccess,
  });
  const app = context.defineCollections({ posts, audits });
  const postsActions = app.posts.actions((defineAction) => ({
    touch: defineAction()
      .policy(fullAccess)
      .handler(({ id }) => ({ id })),
  }));

  expect(() => app.actions({ audits: postsActions } as never)).toThrow(
    /defined for scope "posts" but registered under "audits"/,
  );
});

test("detached and root actions reject schema-bound gate policies at registration", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  const bound = context.policy(Post, () => fullAccess);
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const detachedActions = app.posts.actions((defineAction) => ({
    bad: defineAction()
      .detached()
      // @ts-expect-error schema-bound policies are excluded from detached gates
      .policy(bound)
      .handler(() => null),
  }));
  expect(() => app.actions({ posts: detachedActions })).toThrow(
    /Schema-bound policies require a document action gate/,
  );

  const root = app
    .defineAction()
    // @ts-expect-error schema-bound policies are excluded from root gates
    .policy(bound)
    .handler(() => null);
  expect(() => app.actions({ $: { root } })).toThrow(
    /Schema-bound policies require a document action gate/,
  );
});

test("collection action definitions reject CRUD names and the legacy actions option", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: null }),
  });
  expect(() =>
    context.defineCollection({
      schema: Post,
      accessPolicy: fullAccess,
      actions: () => ({}),
    } as never),
  ).toThrow(/no longer take actions/);
  expect(() =>
    context.defineCollections({
      posts: {
        schema: Post,
        accessPolicy: fullAccess,
        actions: () => ({}),
      } as never,
    }),
  ).toThrow(/no longer take actions/);

  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const crudNamed = app.posts.actions((defineAction) => ({
    // @ts-expect-error CRUD action names are rejected by the public builder type
    get: defineAction()
      .detached()
      .policy(fullAccess)
      .handler(() => ({ bad: true })),
  }));
  expect(() => app.actions({ posts: crudNamed })).toThrow(/reserved name/);
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
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const invalid = app
    .defineAction()
    .policy(fullAccess)
    .handler((() => new Date()) as never);
  const handler = withSqliteTestBackend(app.actions({ $: { invalid } }));
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
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const serialize = app
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
  const handler = withSqliteTestBackend(app.actions({ $: { serialize } }));
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
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const invalidArray = app
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
  const handler = withSqliteTestBackend(app.actions({ $: { invalidArray } }));
  const response = await handler.request("http://fire.test/$:invalidArray", {
    method: "POST",
  });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "INVALID_ACTION_OUTPUT" },
  });
});

test("non-JSON resolved context is rejected equally before SQLite test or DO dispatch", async () => {
  let stubCalls = 0;
  const create = () => {
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
    return context
      .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
      .actions({});
  };

  const production = create();
  for (const handler of [withSqliteTestBackend(production), production]) {
    const response = await handler.request("http://fire.test/posts");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_CONTEXT" },
    });
  }
  expect(stubCalls).toBe(0);
});

function createProductionPostsHandler() {
  const context = createTakibi()({ resolve: resolveTestContext });
  const posts = context.defineCollection({
    schema: Post,
    accessPolicy: postPolicy,
    seed: () => ({ seeded: { title: "from-seed", secret: false } }),
  });
  const app = context.defineCollections({ posts });
  const postsActions = app.posts.actions((defineAction) => ({
    ping: defineAction()
      .detached()
      .policy(fullAccess)
      .handler(() => ({ pong: true as const })),
  }));
  return app.actions({ posts: postsActions });
}

test("SQLite test backend reuses collection actions on an isolated store", async () => {
  const production = createProductionPostsHandler();
  const handler = withSqliteTestBackend(production, { resolve: resolveTestContext });
  const client = createClient<typeof production>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });

  const ping = await client.posts.ping();
  expect(ping).toEqual({ ok: true, data: { pong: true } });

  const created = await client.posts.add({ title: "live" }, { id: "p1" });
  expect(created).toMatchObject({ ok: true, data: { id: "p1", title: "live" } });
  await expect(client.posts.get("seeded")).resolves.toMatchObject({
    ok: true,
    data: { title: "from-seed" },
  });
});

test("two SQLite test backends do not share documents or seeds", async () => {
  const production = createProductionPostsHandler();
  const first = withSqliteTestBackend(production, { resolve: resolveTestContext });
  const second = withSqliteTestBackend(production, { resolve: resolveTestContext });
  const clientA = createClient<typeof production>("http://fire.test", {
    headers,
    fetch: (input, init) => first.request(input, init),
  });
  const clientB = createClient<typeof production>("http://fire.test", {
    headers,
    fetch: (input, init) => second.request(input, init),
  });

  await clientA.posts.add({ title: "only-a" }, { id: "p1" });
  await expect(clientB.posts.get("p1")).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  await expect(clientB.posts.get("seeded")).resolves.toMatchObject({
    ok: true,
    data: { title: "from-seed" },
  });
});

test("SQLite test backend keeps the production resolve and handle context", async () => {
  type Initial = { token: string };
  const seen: Initial[] = [];
  const production = createTakibi<Initial>()({
    resolve: ({ context }) => {
      seen.push(context);
      return { tenantId: "tenant-a", user: { id: "u1", role: "member" as const } };
    },
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const handler = withSqliteTestBackend(production);

  const result = await handler.handle(new Request("http://fire.test/posts/missing"), {
    context: { token: "session-1" },
  });
  expect(result.matched).toBe(true);
  expect(seen).toEqual([{ token: "session-1" }]);
  await expect(result.response!.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("replaced resolve UnauthorizedError stays HTTP 401", async () => {
  const production = createProductionPostsHandler();
  const handler = withSqliteTestBackend(production, {
    resolve: () => {
      throw new UnauthorizedError("Sign in required");
    },
  });
  const response = await handler.request("http://fire.test/posts/p1");
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "UNAUTHORIZED", status: 401 },
  });
});

test("original handle still requires stub after creating a SQLite test backend", async () => {
  let stubFetches = 0;
  const production = createTakibi()({
    resolve: resolveTestContext,
    stub: () =>
      ({
        fetch: async () => {
          stubFetches += 1;
          return Response.json({ ok: true, data: { id: "from-stub" } });
        },
      }) as unknown as DurableObjectStub,
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  const sqlite = withSqliteTestBackend(production, { resolve: resolveTestContext });
  const sqliteClient = createClient<typeof production>("http://fire.test", {
    headers,
    fetch: (input, init) => sqlite.request(input, init),
  });
  await sqliteClient.posts.add({ title: "in-sqlite" }, { id: "p1" });

  const result = await production.handle(
    new Request("http://fire.test/posts/p1", { headers: headers() }),
    {},
  );
  expect(result.matched).toBe(true);
  expect(stubFetches).toBe(1);
  await expect(result.response!.json()).resolves.toEqual({
    ok: true,
    data: { id: "from-stub" },
  });

  const withoutStub = createProductionPostsHandler();
  withSqliteTestBackend(withoutStub, { resolve: resolveTestContext });
  const missing = await withoutStub.handle(
    new Request("http://fire.test/posts/p1", { headers: headers() }),
    {},
  );
  expect(missing.response?.status).toBe(500);
  await expect(missing.response!.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "MISSING_STUB" },
  });
});

test("action handler receives SQLite test backend services", async () => {
  const context = createTakibi()({
    resolve: resolveTestContext,
    services: () => ({ stamp: "from-factory" }),
  });
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const production = app.actions({
    $: {
      ping: app
        .defineAction()
        .policy(fullAccess)
        .handler(({ services }) => ({ stamp: services.stamp })),
    },
  });
  const handler = withSqliteTestBackend(production, {
    services: { stamp: "from-sqlite-test" },
  });
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });
  await expect(client.ping()).resolves.toMatchObject({
    ok: true,
    data: { stamp: "from-sqlite-test" },
  });
});

test("MISSING_SERVICES is thrown at SQLite test backend assembly", () => {
  const context = createTakibi()({
    resolve: resolveTestContext,
    services: () => ({ stamp: "x" }),
  });
  const app = context.defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const production = app.actions({});
  expect(() =>
    // @ts-expect-error SQLite test backend requires services
    withSqliteTestBackend(production),
  ).toThrow(
    expect.objectContaining({
      code: "MISSING_SERVICES",
    }),
  );
});

test("SQLite test backends isolate services from each other", async () => {
  const context = createTakibi()({
    resolve: resolveTestContext,
    services: () => ({ stamp: "unused" }),
  });
  const app = context.defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const production = app.actions({
    $: {
      ping: app
        .defineAction()
        .policy(fullAccess)
        .handler(({ services }) => ({ stamp: services.stamp })),
    },
  });
  const first = withSqliteTestBackend(production, { services: { stamp: "alpha" } });
  const second = withSqliteTestBackend(production, { services: { stamp: "beta" } });
  const clientA = createClient<typeof production>("http://fire.test", {
    headers,
    fetch: (input, init) => first.request(input, init),
  });
  const clientB = createClient<typeof production>("http://fire.test", {
    headers,
    fetch: (input, init) => second.request(input, init),
  });
  await expect(clientA.ping()).resolves.toMatchObject({ ok: true, data: { stamp: "alpha" } });
  await expect(clientB.ping()).resolves.toMatchObject({ ok: true, data: { stamp: "beta" } });
});

test("wire request body does not carry services", async () => {
  let captured: unknown;
  const context = createTakibi()({
    resolve: resolveTestContext,
    services: () => ({ secret: "not-on-wire" }),
    stub: () =>
      ({
        fetch: async (request: Request) => {
          captured = await request.json();
          return Response.json({ ok: true, data: { seen: true } });
        },
      }) as unknown as DurableObjectStub,
  });
  const app = context.defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const handler = app.actions({
    $: {
      ping: app
        .defineAction()
        .policy(fullAccess)
        .handler(({ services }) => ({ secret: services.secret })),
    },
  });

  const response = await handler.request("http://fire.test/$:ping", {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(headers()) },
  });
  expect(response.status).toBe(200);
  expect(captured).toMatchObject({
    kind: "action",
    scope: "$",
    name: "ping",
    context: { tenantId: "tenant-a" },
  });
  expect(captured).not.toHaveProperty("services");
  expect(JSON.stringify(captured)).not.toContain("not-on-wire");
});

test("services factory exception fails Durable Object construction", () => {
  const handler = createTakibi()({
    resolve: resolveTestContext,
    services: () => {
      throw new Error("binding missing");
    },
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  expect(
    () =>
      new handler.DurableObject(
        createFakeDurableObjectState(createSqliteDurableObjectStorage()),
        {},
      ),
  ).toThrow("binding missing");
});

test("generated Durable Object action reads instance services from env", async () => {
  type Env = { LABEL: string };
  const context = createTakibi<Record<string, never>, Env>()({
    resolve: () => ({ tenantId: "tenant-a" }),
    services: ({ env }) => ({ label: env.LABEL }),
  });
  const app = context.defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } });
  const handler = app.actions({
    $: {
      ping: app
        .defineAction()
        .policy(fullAccess)
        .handler(({ services }) => ({ label: services.label })),
    },
  });
  const objectA = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    { LABEL: "alpha" },
  );
  const objectB = new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage(), { name: "tenant-a" }),
    { LABEL: "beta" },
  );
  const invoke = (object: InstanceType<typeof handler.DurableObject>) =>
    object.fetch(
      new Request("https://takibi.internal", {
        method: "POST",
        body: JSON.stringify({
          kind: "action",
          scope: "$",
          name: "ping",
          context: { tenantId: "tenant-a" },
        } satisfies WireRequest),
      }),
    );
  await expect((await invoke(objectA)).json()).resolves.toEqual({
    ok: true,
    data: { label: "alpha" },
  });
  await expect((await invoke(objectB)).json()).resolves.toEqual({
    ok: true,
    data: { label: "beta" },
  });
});

test("indexed list is available on public clients and trusted collections", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const posts = context.defineCollection({
    schema: z.object({ ownerId: z.string(), title: z.string() }),
    accessPolicy: fullAccess,
    indexes: { byOwner: ["ownerId", "createdAt"] },
  });
  const production = context.defineCollections({ posts }).actions({});
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof handler>("http://fire.test", {
    headers,
    fetch: (input, init) => handler.request(input, init),
  });

  vi.useFakeTimers();
  vi.setSystemTime("2026-01-01T00:00:00.000Z");
  await client.posts.add({ ownerId: "u1", title: "second" }, { id: "p2" });
  vi.setSystemTime("2026-01-01T00:00:01.000Z");
  await client.posts.add({ ownerId: "u1", title: "first" }, { id: "p1" });
  await client.posts.add({ ownerId: "u2", title: "other" }, { id: "p3" });
  vi.useRealTimers();

  const page = await client.posts.list({
    index: "byOwner",
    where: (query) => query.ownerId.eq("u1"),
    orderBy: (query) => query.createdAt.desc(),
    limit: 10,
  });
  expect(page.ok).toBe(true);
  if (page.ok) {
    expect(page.data.items.map((document) => document.id)).toEqual(["p1", "p2"]);
  }

  const unknown = await client.posts.list({
    index: "missing",
    where: (query: { ownerId: { eq(value: string): unknown } }) => query.ownerId.eq("u1"),
  } as never);
  expect(unknown).toMatchObject({
    ok: false,
    error: { code: "BAD_REQUEST", status: 400 },
  });
});

test("handlers expose no post-hoc action registration surface", () => {
  const production = createProductionPostsHandler();
  const forked = withSqliteTestBackend(production, { resolve: resolveTestContext });

  for (const handler of [production, forked]) {
    expect(Reflect.get(handler, "defineAction")).toBeUndefined();
    expect(Reflect.get(handler, "actions")).toBeUndefined();
  }
});
