import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { ALL, CREATE, EDIT, READ, createClient, createContext } from "../src/index";
import type { WireRequest, WireResponse } from "../src/protocol";

type User = { id: string; role: "admin" | "member" };
type AppCtx = { tenantId: string; user: User | null };

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
  const context = createContext<AppCtx>({ resolve: resolveTestContext });

  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessControl({ user }) {
          if (user?.role === "admin") return ALL;
          if (user) return [READ, CREATE, EDIT];
          return READ;
        },
      },
    },
    { memory: true },
  );

  return handler;
}

function createCreateOnlyApp() {
  const context = createContext<AppCtx>({ resolve: resolveTestContext });

  return context.resources(
    {
      posts: {
        schema: Post,
        accessControl({ user }) {
          if (user?.role === "admin") return ALL;
          if (user) return CREATE;
          return READ;
        },
      },
    },
    { memory: true },
  );
}

function createStrictApp() {
  const context = createContext<AppCtx>({ resolve: resolveTestContext });

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
        accessControl({ user }) {
          return user ? ALL : READ;
        },
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
  const context = createContext<AppCtx>({ resolve: resolveTestContext });

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
        accessControl() {
          return ALL;
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

test("CREATE-only grant cannot overwrite via add", async () => {
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
  const context = createContext<AppCtx>({
    resolve: () => ({ tenantId: "public", user: null }),
  });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessControl({ user }) {
          if (user) return ALL;
          return READ;
        },
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
  const context = createContext<AppCtx>({
    resolve: () => ({ tenantId: "tenant-a", user: null }),
  });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessControl({ user }) {
          if (user?.role === "admin") return ALL;
          if (user) return [READ, CREATE, EDIT];
          return READ;
        },
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
  };

  const context = createContext<AppCtx>({
    resolve: () => ({
      tenantId: "resolved-tenant",
      user: { id: "u1", role: "member" },
    }),
  });
  const handler = context.resources({
    posts: {
      schema: Post,
      accessControl() {
        return ALL;
      },
    },
  });

  const res = await handler.request(
    "http://fire.test/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-id": "attacker-tenant",
      },
      body: JSON.stringify({
        resource: "posts",
        operation: "list",
      }),
    },
    { TENANT_STORE: fakeNs },
  );

  expect(res.status).toBe(200);
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
  const context = createContext<AppCtx>({
    resolve: () => ({ tenantId: "", user: null }),
  });
  const handler = context.resources(
    {
      posts: {
        schema: Post,
        accessControl() {
          return READ;
        },
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
