import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { ALL, CREATE, EDIT, READ, createClient, createContext } from "../src/index";
import type { WireResponse } from "../src/protocol";

type User = { id: string; role: "admin" | "member" };

const Post = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  body: z.string(),
  authorId: z.string(),
});

function createTestApp() {
  const context = createContext<{ tenantId: string; user: User | null }>(({ tenantId, user }) => ({
    tenantId,
    user: user as User | null,
  }));

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

function headers(tenantId: string, user: User | null) {
  const h = new Headers({ "x-tenant-id": tenantId });
  if (user) h.set("x-user", JSON.stringify(user));
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

test("missing tenant is unauthorized", async () => {
  const handler = createTestApp();
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
