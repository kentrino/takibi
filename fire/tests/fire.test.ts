import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createClient, createContext, defineResource, fire, ownedBy } from "../src/index";
import type { AccessAction, AccessContext } from "../src/index";
import type { WireRequest, WireResponse } from "../src/protocol";
import { setClockForTests } from "../src/typed-storage";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

function memberPolicy({ user, action }: AccessContext<AppCtx>): boolean {
  if (user?.role === "admin") return true;
  if (action === "get" || action === "list") return true;
  return user != null;
}

function createOnlyPolicy({ user, action }: AccessContext<AppCtx>): boolean {
  if (user?.role === "admin") return true;
  if (action === "get" || action === "list") return true;
  if (action === "create") return user != null;
  return false;
}

function updateOnlyPolicy({ user, action }: AccessContext<AppCtx>): boolean {
  if (user?.role === "admin") return true;
  if (action === "get" || action === "list") return true;
  if (action === "update") return user != null;
  return false;
}

function readPolicy({ action }: AccessContext<AppCtx>): boolean {
  return action === "get" || action === "list";
}

/**
 * Test-only context assembly. Not a package export — production apps must
 * verify credentials and tenant membership inside their own `resolve`.
 */
function resolveTestContext({ request }: { request: Request }): AppCtx {
  const tenantId = request.headers.get("x-test-tenant") ?? "";
  const raw = request.headers.get("x-test-user");
  if (!raw) return { tenantId, user: null };
  return { tenantId, user: JSON.parse(raw) as User };
}

const Post = z.object({
  title: z.string().min(1),
  body: z.string(),
  authorId: z.string(),
});

function createTestApp() {
  const context = createContext({ resolve: resolveTestContext });

  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: memberPolicy,
      },
    },
    { memory: true },
  );

  return handler;
}

function createCreateOnlyApp() {
  const context = createContext({ resolve: resolveTestContext });

  return context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: createOnlyPolicy,
      },
    },
    { memory: true },
  );
}

function createStrictApp() {
  const context = createContext({ resolve: resolveTestContext });

  return context.resources(
    {
      posts: {
        schema: z
          .object({
            title: z.string().min(1),
            body: z.string(),
            authorId: z.string(),
          })
          .strict(),
        accessPolicy: memberPolicy,
      },
    },
    { memory: true },
  );
}

function headers(tenantId: string, user: User | null) {
  const h = new Headers({ "x-test-tenant": tenantId });
  if (user) h.set("x-test-user", JSON.stringify(user));
  return h;
}

test("client add / get / list roundtrip", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await client.posts.add({
    title: "Hello",
    body: "world",
    authorId: "u1",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.data.title).toBe("Hello");
  expect(created.data.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i);

  const got = await client.posts.get(created.data.id);
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.data.body).toBe("world");

  const listed = await client.posts.list();
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.data.items).toHaveLength(1);
});

test("add with caller-chosen id", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await client.posts.add(
    { title: "Hello", body: "world", authorId: "u1" },
    { id: "post-1" },
  );
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.data.id).toBe("post-1");

  const storageCreated = await handler.storage.posts.add(
    { title: "via storage", body: "trusted", authorId: "system" },
    { id: "post-storage" },
  );
  expect(storageCreated.ok).toBe(true);
  if (!storageCreated.ok) return;
  expect(storageCreated.data.id).toBe("post-storage");
});

test("add wire payload separates id from input", async () => {
  const handler = createTestApp();
  let captured: WireRequest | undefined;

  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: async (input, init) => {
      const body = init?.body;
      captured = JSON.parse(typeof body === "string" ? body : "") as WireRequest;
      return handler.request(input, init);
    },
  });

  await client.posts.add({ title: "Hi", body: "x", authorId: "u1" }, { id: "wire-id" });
  expect(captured).toMatchObject({
    resource: "posts",
    operation: "add",
    id: "wire-id",
    input: { title: "Hi", body: "x", authorId: "u1" },
  });
  expect(captured?.input).not.toHaveProperty("id");
});

test("add rejects reserved id in data and empty option id", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const reserved = await client.posts.add({
    title: "Hi",
    body: "x",
    authorId: "u1",
    // @ts-expect-error id belongs in options, not data
    id: "sneaky",
  });
  expect(reserved).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  if (!reserved.ok && reserved.error.kind === "validation") {
    expect(reserved.error.issues.some((issue) => issue.path?.includes("id"))).toBe(true);
  }

  const emptyId = await client.posts.add({ title: "Hi", body: "x", authorId: "u1" }, { id: "" });
  expect(emptyId).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });

  const storageReserved = await handler.storage.posts.add({
    title: "Hi",
    body: "x",
    authorId: "u1",
    // @ts-expect-error id belongs in options, not data
    id: "sneaky",
  });
  expect(storageReserved).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
});

test("schema transform that injects id is rejected", async () => {
  const context = createContext({ resolve: resolveTestContext });

  const handler = context.resources(
    {
      posts: {
        schema: z
          .object({
            title: z.string(),
            body: z.string(),
            authorId: z.string(),
          })
          .transform((value) => ({ ...value, id: "from-schema" })),
        accessPolicy() {
          return true;
        },
      },
    },
    { memory: true },
  );

  const result = await handler.storage.posts.add({
    title: "Hi",
    body: "x",
    authorId: "u1",
  });
  expect(result).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  if (!result.ok && result.error.kind === "validation") {
    expect(result.error.issues.some((issue) => issue.path?.includes("id"))).toBe(true);
  }
});

test("strict schema succeeds for add / set / update", async () => {
  const handler = createStrictApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await client.posts.add({
    title: "strict",
    body: "ok",
    authorId: "u1",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const set = await client.posts.set("strict-1", {
    title: "set",
    body: "ok",
    authorId: "u1",
  });
  expect(set.ok).toBe(true);

  const updated = await client.posts.update(created.data.id, { title: "updated" });
  expect(updated.ok).toBe(true);
  if (!updated.ok) return;
  expect(updated.data.title).toBe("updated");
  expect(updated.data.id).toBe(created.data.id);
});

test("add collision returns ALREADY_EXISTS without overwriting", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const first = await client.posts.add(
    { title: "original", body: "keep", authorId: "u1" },
    { id: "same-id" },
  );
  expect(first.ok).toBe(true);

  const second = await client.posts.add(
    { title: "overwrite?", body: "nope", authorId: "u1" },
    { id: "same-id" },
  );
  expect(second).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "ALREADY_EXISTS", status: 409 },
  });

  const got = await client.posts.get("same-id");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.data.title).toBe("original");

  const storageSecond = await handler.storage.posts.add(
    { title: "storage overwrite?", body: "nope", authorId: "system" },
    { id: "same-id" },
  );
  expect(storageSecond).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "ALREADY_EXISTS", status: 409 },
  });
});

test("create-only policy cannot overwrite via add", async () => {
  const handler = createCreateOnlyApp();
  const admin = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "admin", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const seeded = await admin.posts.set("owned", {
    title: "admin doc",
    body: "secret",
    authorId: "admin",
  });
  expect(seeded.ok).toBe(true);

  const attempt = await member.posts.add(
    { title: "hijack", body: "stolen", authorId: "u1" },
    { id: "owned" },
  );
  expect(attempt).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "ALREADY_EXISTS", status: 409 },
  });

  const got = await admin.posts.get("owned");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.data.title).toBe("admin doc");
});

test("create-only policy cannot overwrite via set", async () => {
  const handler = createCreateOnlyApp();
  const admin = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "admin", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const seeded = await admin.posts.set("owned", {
    title: "admin doc",
    body: "secret",
    authorId: "admin",
  });
  expect(seeded.ok).toBe(true);

  const attempt = await member.posts.set("owned", {
    title: "hijack",
    body: "stolen",
    authorId: "u1",
  });
  // Existing-document denial conceals existence.
  expect(attempt).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "NOT_FOUND", status: 404 },
  });

  const got = await admin.posts.get("owned");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.data.title).toBe("admin doc");
});

test("update-only policy cannot create via set", async () => {
  const context = createContext({ resolve: resolveTestContext });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: updateOnlyPolicy,
      },
    },
    { memory: true },
  );
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const attempt = await member.posts.set("new-id", {
    title: "new",
    body: "x",
    authorId: "u1",
  });
  expect(attempt).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });
});

test("accessPolicy receives create/update action for set", async () => {
  const seen: AccessAction[] = [];
  const context = createContext({ resolve: resolveTestContext });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy({ action }) {
          seen.push(action);
          return true;
        },
      },
    },
    { memory: true },
  );
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await client.posts.set("doc-1", {
    title: "one",
    body: "x",
    authorId: "u1",
  });
  expect(created.ok).toBe(true);

  const updated = await client.posts.set("doc-1", {
    title: "two",
    body: "y",
    authorId: "u1",
  });
  expect(updated.ok).toBe(true);
  expect(seen).toEqual(["create", "update"]);
});

test("anonymous cannot create", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", null),
    fetch: (input, init) => handler.request(input, init),
  });

  const result = await client.posts.add({ title: "nope", body: "x", authorId: "anon" });
  expect(result).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });
});

test("explicit anonymous resolve (user: null) can still read", async () => {
  const context = createContext({
    resolve: () => ({ tenantId: "public", user: null }),
  });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: memberPolicy,
      },
    },
    { memory: true },
  );

  await handler.storage.posts.add(
    { title: "public", body: "ok", authorId: "system" },
    { id: "p1" },
  );

  const client = createClient<typeof handler>("http://fire.test/", {
    fetch: (input, init) => handler.request(input, init),
  });
  const listed = await client.posts.list();
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.data.items).toHaveLength(1);

  const created = await client.posts.add({ title: "nope", body: "x", authorId: "anon" });
  expect(created).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });
});

test("client-claimed x-user does not change identity or permissions", async () => {
  const context = createContext({
    resolve: () => ({ tenantId: "tenant-a", user: null }),
  });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: memberPolicy,
      },
    },
    { memory: true },
  );

  const res = await handler.request("http://fire.test/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user": JSON.stringify({ id: "attacker", role: "admin" }),
    },
    body: JSON.stringify({
      resource: "posts",
      operation: "add",
      input: { title: "hijack", body: "x", authorId: "attacker" },
    }),
  });
  expect(res.status).toBe(403);
  const json = (await res.json()) as WireResponse;
  expect(json).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });
});

test("resolve tenantId is used for idFromName, not x-tenant-id", async () => {
  const idFromNameCalls: string[] = [];
  let forwardedContext: unknown;

  const fakeNs = {
    idFromName(name: string) {
      idFromNameCalls.push(name);
      return name as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        fetch: async (request: Request) => {
          const body = (await request.json()) as WireRequest;
          forwardedContext = body.context;
          return Response.json({
            ok: true,
            data: { items: [], nextCursor: null },
          } satisfies WireResponse);
        },
      };
    },
  } as unknown as DurableObjectNamespace;

  type Initial = { env: { TENANT_STORE: DurableObjectNamespace } };
  const createContextWithInitial = fire.initialContext<Initial>();
  const context = createContextWithInitial({
    resolve: () => ({
      tenantId: "resolved-tenant",
      user: { id: "u1", role: "member" },
    }),
    stub: ({ context: input, tenantId }) => {
      const ns = input.env.TENANT_STORE;
      return ns.get(ns.idFromName(tenantId));
    },
  });
  const handler = context.resources({
    posts: {
      schema: Post,
      accessPolicy() {
        return true;
      },
    },
  });

  const { matched, response: res } = await handler.handle(
    new Request("http://fire.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": "attacker-tenant",
      },
      body: JSON.stringify({
        resource: "posts",
        operation: "list",
      }),
    }),
    {
      context: { env: { TENANT_STORE: fakeNs } },
    },
  );

  expect(matched).toBe(true);
  expect(res?.status).toBe(200);
  expect(idFromNameCalls).toEqual(["resolved-tenant"]);
  expect(forwardedContext).toEqual({
    tenantId: "resolved-tenant",
    user: { id: "u1", role: "member" },
  });
});

test("schema validation rejects bad input with issues", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const result = await client.posts.add({ title: "", body: "x", authorId: "u1" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    kind: "validation",
    code: "VALIDATION",
    status: 400,
  });
  expect(result.error.kind === "validation" && result.error.issues.length).toBeGreaterThan(0);
  if (result.error.kind === "validation") {
    expect(result.error.issues.some((issue) => typeof issue.message === "string")).toBe(true);
    expect(
      result.error.issues.some(
        (issue) => Array.isArray(issue.path) && issue.path.includes("title"),
      ),
    ).toBe(true);
    for (const issue of result.error.issues) {
      expect(Object.keys(issue).every((key) => key === "message" || key === "path")).toBe(true);
    }
  }
});

test("storage.posts.add works as trusted admin API", async () => {
  const handler = createTestApp();
  const doc = await handler.storage.posts.add({
    title: "via storage",
    body: "trusted",
    authorId: "system",
  });
  expect(doc.ok).toBe(true);
  if (!doc.ok) return;
  expect(doc.data.title).toBe("via storage");

  const again = await handler.storage.posts.get(doc.data.id);
  expect(again.ok).toBe(true);
  if (!again.ok) return;
  expect(again.data.body).toBe("trusted");
});

test("update + delete", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await client.posts.add({
    title: "t",
    body: "b",
    authorId: "u1",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const updated = await client.posts.update(created.data.id, { title: "t2" });
  expect(updated.ok).toBe(true);
  if (!updated.ok) return;
  expect(updated.data.title).toBe("t2");

  const deleted = await client.posts.delete(created.data.id);
  expect(deleted.ok).toBe(true);

  const missing = await client.posts.get(created.data.id);
  expect(missing).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "NOT_FOUND", status: 404 },
  });
});

test("missing get / update / delete return NOT_FOUND for client and storage", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const id = "missing-doc";
  for (const result of [
    await client.posts.get(id),
    await client.posts.update(id, { title: "x" }),
    await client.posts.delete(id),
    await handler.storage.posts.get(id),
    await handler.storage.posts.update(id, { title: "x" }),
    await handler.storage.posts.delete(id),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "operation", code: "NOT_FOUND", status: 404 },
    });
  }
});

test("set upserts a missing id", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const result = await client.posts.set("brand-new", {
    title: "created by set",
    body: "ok",
    authorId: "u1",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.id).toBe("brand-new");

  const storageSet = await handler.storage.posts.set("from-storage", {
    title: "storage set",
    body: "ok",
    authorId: "system",
  });
  expect(storageSet.ok).toBe(true);
});

test("transport and protocol failures reject instead of returning FireFailure", async () => {
  const handler = createTestApp();

  const fetchRejectClient = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: async () => {
      throw new TypeError("network down");
    },
  });
  await expect(fetchRejectClient.posts.list()).rejects.toThrow("network down");

  const badJsonClient = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await expect(badJsonClient.posts.list()).rejects.toThrow();

  const badEnvelopeClient = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await expect(badEnvelopeClient.posts.list()).rejects.toThrow("Invalid response envelope");
});

test("empty tenantId from resolve is unauthorized", async () => {
  const context = createContext({
    resolve: () => ({ tenantId: "", user: null }),
  });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: readPolicy,
      },
    },
    { memory: true },
  );

  const res = await handler.request("http://fire.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resource: "posts",
      operation: "list",
    }),
  });
  expect(res.status).toBe(401);
  const json = (await res.json()) as WireResponse;
  expect(json.ok).toBe(false);
  if (!json.ok) {
    expect(json.error).toMatchObject({
      kind: "operation",
      code: "UNAUTHORIZED",
      status: 401,
    });
  }
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("add stamps equal createdAt / updatedAt; HTTP and trusted storage agree", async () => {
  const t0 = new Date("2026-08-09T14:12:00.000Z");
  setClockForTests(() => t0);
  try {
    const handler = createTestApp();
    const client = createClient<typeof handler>("http://fire.test/", {
      headers: () => headers("tenant-a", { id: "u1", role: "member" }),
      fetch: (input, init) => handler.request(input, init),
    });

    const created = await client.posts.add({
      title: "Hello",
      body: "world",
      authorId: "u1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.createdAt).toBe("2026-08-09T14:12:00.000Z");
    expect(created.data.updatedAt).toBe(created.data.createdAt);
    expect(created.data.createdAt).toMatch(ISO_RE);

    const storageCreated = await handler.storage.posts.add({
      title: "via storage",
      body: "trusted",
      authorId: "system",
    });
    expect(storageCreated.ok).toBe(true);
    if (!storageCreated.ok) return;
    expect(storageCreated.data.createdAt).toBe("2026-08-09T14:12:00.000Z");
    expect(storageCreated.data.updatedAt).toBe(storageCreated.data.createdAt);

    const listed = await client.posts.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    for (const item of listed.data.items) {
      expect(item.createdAt).toMatch(ISO_RE);
      expect(item.updatedAt).toMatch(ISO_RE);
    }
  } finally {
    setClockForTests(undefined);
  }
});

test("set create and overwrite preserve createdAt; empty writes still bump updatedAt", async () => {
  const t0 = new Date("2026-08-09T14:12:00.000Z");
  const t1 = new Date("2026-08-09T15:00:00.000Z");
  let now = t0;
  setClockForTests(() => now);
  try {
    const handler = createTestApp();
    const client = createClient<typeof handler>("http://fire.test/", {
      headers: () => headers("tenant-a", { id: "u1", role: "admin" }),
      fetch: (input, init) => handler.request(input, init),
    });

    const created = await client.posts.set("doc-1", {
      title: "first",
      body: "a",
      authorId: "u1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.createdAt).toBe(created.data.updatedAt);
    expect(created.data.createdAt).toBe("2026-08-09T14:12:00.000Z");

    now = t1;
    const overwritten = await client.posts.set("doc-1", {
      title: "second",
      body: "a",
      authorId: "u1",
    });
    expect(overwritten.ok).toBe(true);
    if (!overwritten.ok) return;
    expect(overwritten.data.createdAt).toBe("2026-08-09T14:12:00.000Z");
    expect(overwritten.data.updatedAt).toBe("2026-08-09T15:00:00.000Z");

    const sameValue = await client.posts.set("doc-1", {
      title: "second",
      body: "a",
      authorId: "u1",
    });
    expect(sameValue.ok).toBe(true);
    if (!sameValue.ok) return;
    expect(sameValue.data.createdAt).toBe("2026-08-09T14:12:00.000Z");
    expect(sameValue.data.updatedAt).toBe("2026-08-09T15:00:00.000Z");

    const emptyPatch = await client.posts.update("doc-1", {});
    expect(emptyPatch.ok).toBe(true);
    if (!emptyPatch.ok) return;
    expect(emptyPatch.data.createdAt).toBe("2026-08-09T14:12:00.000Z");
    expect(emptyPatch.data.updatedAt).toBe("2026-08-09T15:00:00.000Z");
    expect(emptyPatch.data.title).toBe("second");
  } finally {
    setClockForTests(undefined);
  }
});

test("same-millisecond consecutive writes may share updatedAt", async () => {
  const fixed = new Date("2026-08-09T14:12:00.000Z");
  setClockForTests(() => fixed);
  try {
    const handler = createTestApp();
    const first = await handler.storage.posts.add(
      { title: "a", body: "x", authorId: "u1" },
      { id: "same-ms" },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await handler.storage.posts.update("same-ms", { title: "b" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.createdAt).toBe(first.data.createdAt);
    expect(second.data.updatedAt).toBe(first.data.updatedAt);
    expect(second.data.updatedAt).toBe("2026-08-09T14:12:00.000Z");
  } finally {
    setClockForTests(undefined);
  }
});

test("reserved createdAt / updatedAt in input and schema transform are rejected", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const sneakyCreated = await client.posts.add({
    title: "Hi",
    body: "x",
    authorId: "u1",
    // @ts-expect-error createdAt is server-managed
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  expect(sneakyCreated).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  if (!sneakyCreated.ok && sneakyCreated.error.kind === "validation") {
    expect(sneakyCreated.error.issues.some((issue) => issue.path?.includes("createdAt"))).toBe(
      true,
    );
  }

  const sneakyUpdated = await handler.storage.posts.set("x", {
    title: "Hi",
    body: "x",
    authorId: "u1",
    // @ts-expect-error updatedAt is server-managed
    updatedAt: "2020-01-01T00:00:00.000Z",
  });
  expect(sneakyUpdated).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  if (!sneakyUpdated.ok && sneakyUpdated.error.kind === "validation") {
    expect(sneakyUpdated.error.issues.some((issue) => issue.path?.includes("updatedAt"))).toBe(
      true,
    );
  }

  const context = createContext({ resolve: resolveTestContext });
  const transformHandler = context.resources(
    {
      posts: {
        schema: z
          .object({
            title: z.string(),
            body: z.string(),
            authorId: z.string(),
          })
          .transform((value) => ({
            ...value,
            createdAt: "2020-01-01T00:00:00.000Z",
          })),
        accessPolicy() {
          return true;
        },
      },
    },
    { memory: true },
  );

  const fromSchema = await transformHandler.storage.posts.add({
    title: "Hi",
    body: "x",
    authorId: "u1",
  });
  expect(fromSchema).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  if (!fromSchema.ok && fromSchema.error.kind === "validation") {
    expect(fromSchema.error.issues.some((issue) => issue.path?.includes("createdAt"))).toBe(true);
  }
});

test("list remains ordered by id, not timestamp", async () => {
  const tEarly = new Date("2026-08-09T10:00:00.000Z");
  const tLate = new Date("2026-08-09T20:00:00.000Z");
  let now = tLate;
  setClockForTests(() => now);
  try {
    const handler = createTestApp();
    await handler.storage.posts.add({ title: "z-late", body: "x", authorId: "u1" }, { id: "z" });
    now = tEarly;
    await handler.storage.posts.add({ title: "a-early", body: "x", authorId: "u1" }, { id: "a" });

    const listed = await handler.storage.posts.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.items.map((d) => d.id)).toEqual(["a", "z"]);
    expect(listed.data.items[0]!.createdAt).toBe("2026-08-09T10:00:00.000Z");
    expect(listed.data.items[1]!.createdAt).toBe("2026-08-09T20:00:00.000Z");
  } finally {
    setClockForTests(undefined);
  }
});

const OwnedNote = z.object({
  ownerId: z.string().min(1),
  title: z.string().min(1),
});

function createOwnedApp() {
  const context = createContext({ resolve: resolveTestContext });
  return context.resources(
    {
      notes: defineResource({
        schema: OwnedNote,
        accessPolicy: ownedBy({
          subject: ({ user }) => (user as User | null)?.id,
          bypass: ({ user }) => (user as User | null)?.role === "admin",
        }),
      }),
    },
    { memory: true },
  );
}

function createAuthorOwnedApp() {
  const context = createContext({ resolve: resolveTestContext });
  return context.resources(
    {
      posts: defineResource({
        schema: Post,
        accessPolicy: ownedBy({
          field: "authorId",
          subject: ({ user }) => (user as User | null)?.id,
          bypass: ({ user }) => (user as User | null)?.role === "admin",
        }),
      }),
    },
    { memory: true },
  );
}

test("ownedBy: owner can add/get/update/delete; stranger gets NOT_FOUND", async () => {
  const handler = createOwnedApp();
  const owner = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });
  const stranger = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u2", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await owner.notes.add({ ownerId: "u1", title: "mine" }, { id: "n1" });
  expect(created.ok).toBe(true);

  const got = await owner.notes.get("n1");
  expect(got.ok).toBe(true);

  const updated = await owner.notes.update("n1", { title: "mine-2" });
  expect(updated.ok).toBe(true);
  if (!updated.ok) return;
  expect(updated.data.title).toBe("mine-2");

  for (const result of [
    await stranger.notes.get("n1"),
    await stranger.notes.update("n1", { title: "hijack" }),
    await stranger.notes.delete("n1"),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "operation", code: "NOT_FOUND", status: 404 },
    });
  }

  const stillThere = await owner.notes.get("n1");
  expect(stillThere.ok).toBe(true);

  const deleted = await owner.notes.delete("n1");
  expect(deleted.ok).toBe(true);
});

test("ownedBy: create with foreign ownerId is FORBIDDEN; existing set denial is NOT_FOUND", async () => {
  const handler = createOwnedApp();
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const foreignAdd = await member.notes.add({ ownerId: "other", title: "nope" });
  expect(foreignAdd).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });

  const foreignSet = await member.notes.set("new-note", { ownerId: "other", title: "nope" });
  expect(foreignSet).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });

  const owned = await member.notes.set("n1", { ownerId: "u1", title: "ok" });
  expect(owned.ok).toBe(true);

  const transfer = await member.notes.set("n1", { ownerId: "u2", title: "steal" });
  expect(transfer).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "NOT_FOUND", status: 404 },
  });

  const patchOwner = await member.notes.update("n1", { ownerId: "u2" });
  expect(patchOwner).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "NOT_FOUND", status: 404 },
  });

  const unchanged = await member.notes.get("n1");
  expect(unchanged.ok).toBe(true);
  if (!unchanged.ok) return;
  expect(unchanged.data.ownerId).toBe("u1");
  expect(unchanged.data.title).toBe("ok");
});

test("ownedBy: list is FORBIDDEN for members; admin bypass allows all ops", async () => {
  const handler = createOwnedApp();
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });
  const admin = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "admin", role: "admin" }),
    fetch: (input, init) => handler.request(input, init),
  });

  await handler.storage.notes.add({ ownerId: "u1", title: "a" }, { id: "a" });
  await handler.storage.notes.add({ ownerId: "u2", title: "b" }, { id: "b" });

  const memberList = await member.notes.list();
  expect(memberList).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });

  const adminList = await admin.notes.list();
  expect(adminList.ok).toBe(true);
  if (!adminList.ok) return;
  expect(adminList.data.items).toHaveLength(2);

  const adminGet = await admin.notes.get("b");
  expect(adminGet.ok).toBe(true);

  const adminUpdate = await admin.notes.update("b", { title: "b2", ownerId: "admin" });
  expect(adminUpdate.ok).toBe(true);
});

test("ownedBy: missing docs never call policy; nextDoc matches stored value", async () => {
  const seen: Array<{
    operation: string;
    action: string;
    docOwner?: string;
    nextOwner?: string;
    nextId?: string;
    nextUpdatedAt?: string;
  }> = [];
  const context = createContext({ resolve: resolveTestContext });
  const handler = context.resources(
    {
      notes: defineResource({
        schema: OwnedNote,
        accessPolicy(ctx) {
          seen.push({
            operation: ctx.operation,
            action: ctx.action,
            docOwner: ctx.doc?.ownerId,
            nextOwner: ctx.nextDoc?.ownerId,
            nextId: ctx.nextDoc?.id,
            nextUpdatedAt: ctx.nextDoc?.updatedAt,
          });
          return ownedBy({
            subject: ({ user }: AccessContext<AppCtx>) => user?.id,
          })(ctx);
        },
      }),
    },
    { memory: true },
  );
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const beforeMissing = seen.length;
  for (const result of [
    await client.notes.get("missing"),
    await client.notes.update("missing", { title: "x" }),
    await client.notes.delete("missing"),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "operation", code: "NOT_FOUND", status: 404 },
    });
  }
  expect(seen.length).toBe(beforeMissing);

  const created = await client.notes.add({ ownerId: "u1", title: "t" }, { id: "n1" });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const addSeen = seen.find((s) => s.operation === "add");
  expect(addSeen).toMatchObject({
    action: "create",
    nextOwner: "u1",
    nextId: "n1",
  });
  expect(addSeen?.nextUpdatedAt).toBe(created.data.updatedAt);
  expect(addSeen?.docOwner).toBeUndefined();

  const updated = await client.notes.update("n1", { title: "t2" });
  expect(updated.ok).toBe(true);
  if (!updated.ok) return;
  const updateSeen = seen.find((s) => s.operation === "update");
  expect(updateSeen).toMatchObject({
    action: "update",
    docOwner: "u1",
    nextOwner: "u1",
    nextId: "n1",
  });
  expect(updateSeen?.nextUpdatedAt).toBe(updated.data.updatedAt);
});

test("ownedBy field: authorId works; trusted storage bypasses policy but validates schema", async () => {
  const handler = createAuthorOwnedApp();
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const created = await member.posts.add({
    title: "Hi",
    body: "x",
    authorId: "u1",
  });
  expect(created.ok).toBe(true);

  const trusted = await handler.storage.posts.add(
    { title: "sys", body: "x", authorId: "system" },
    { id: "sys-1" },
  );
  expect(trusted.ok).toBe(true);

  const invalid = await handler.storage.posts.add({
    title: "bad",
    body: "x",
    authorId: 1 as unknown as string,
  });
  expect(invalid.ok).toBe(false);

  const strangerGet = await member.posts.get("sys-1");
  expect(strangerGet).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "NOT_FOUND", status: 404 },
  });
});

test("custom accessPolicy without owner field still works", async () => {
  const context = createContext({ resolve: resolveTestContext });
  const handler = context.resources(
    {
      posts: defineResource({
        schema: z.object({ title: z.string(), published: z.boolean() }),
        accessPolicy({ user, action, nextDoc }) {
          if (user?.role === "admin") return true;
          if (action === "create") return nextDoc?.published === false;
          if (action === "get" || action === "list") return true;
          return false;
        },
      }),
    },
    { memory: true },
  );
  const member = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  const draft = await member.posts.add({ title: "draft", published: false });
  expect(draft.ok).toBe(true);

  const published = await member.posts.add({ title: "live", published: true });
  expect(published).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });
});

test("handle injects typed initial context into resolve", async () => {
  type Initial = { container: { tenantId: string; user: User | null } };

  const createContextWithInitial = fire.initialContext<Initial>();
  const context = createContextWithInitial({
    resolve: ({ context: input }) => ({
      tenantId: input.container.tenantId,
      user: input.container.user,
    }),
  });

  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessPolicy: memberPolicy,
      },
    },
    { memory: true },
  );

  const client = createClient<typeof handler>("http://fire.test/rpc", {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const { matched, response } = await handler.handle(request, {
        prefix: "/rpc",
        context: {
          container: {
            tenantId: "tenant-a",
            user: { id: "u1", role: "member" },
          },
        },
      });
      expect(matched).toBe(true);
      return response!;
    },
  });

  const created = await client.posts.add({
    title: "Hello",
    body: "from handle",
    authorId: "u1",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.data.title).toBe("Hello");
});

test("handle returns matched:false when prefix does not match", async () => {
  const handler = createTestApp();
  const result = await handler.handle(new Request("http://fire.test/other", { method: "POST" }), {
    prefix: "/rpc",
  });
  expect(result).toEqual({ matched: false });
});

test("handle rejects non-POST with 405 when prefix matches", async () => {
  const handler = createTestApp();
  const result = await handler.handle(new Request("http://fire.test/rpc", { method: "GET" }), {
    prefix: "/rpc",
  });
  expect(result.matched).toBe(true);
  expect(result.response?.status).toBe(405);
});

test("handle uses stub from initial context for Durable Object routing", async () => {
  const idFromNameCalls: string[] = [];
  const fakeNs = {
    idFromName(name: string) {
      idFromNameCalls.push(name);
      return name as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        fetch: async () =>
          Response.json({
            ok: true,
            data: { items: [], nextCursor: null },
          } satisfies WireResponse),
      };
    },
  } as unknown as DurableObjectNamespace;

  type Initial = {
    di: { tenantId: string };
    env: { TENANT_STORE: DurableObjectNamespace };
  };
  const createContextWithInitial = fire.initialContext<Initial>();
  const context = createContextWithInitial({
    resolve: ({ context: input }) => ({
      tenantId: input.di.tenantId,
      user: { id: "u1", role: "member" },
    }),
    stub: ({ context: input, tenantId }) => {
      const ns = input.env.TENANT_STORE;
      return ns.get(ns.idFromName(tenantId));
    },
  });
  const handler = context.resources({
    posts: {
      schema: Post,
      accessPolicy: () => true,
    },
  });

  const { matched, response } = await handler.handle(
    new Request("http://fire.test/api/fire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: "posts", operation: "list" }),
    }),
    {
      prefix: "/api/fire",
      context: {
        di: { tenantId: "from-di" },
        env: { TENANT_STORE: fakeNs },
      },
    },
  );

  expect(matched).toBe(true);
  expect(response?.status).toBe(200);
  expect(idFromNameCalls).toEqual(["from-di"]);
});
