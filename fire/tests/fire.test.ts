import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { ALL, CREATE, EDIT, FireError, READ, createClient, createContext } from "../src/index";
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

  expect(created.title).toBe("Hello");
  expect(created.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i);

  const got = await client.posts.get(created.id);
  expect(got?.body).toBe("world");

  const listed = await client.posts.list();
  expect(listed.items).toHaveLength(1);
});

test("anonymous cannot create", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", null),
    fetch: (input, init) => handler.request(input, init),
  });

  await expect(
    client.posts.add({ title: "nope", body: "x", authorId: "anon" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 } satisfies Partial<FireError>);
});

test("schema validation rejects bad input", async () => {
  const handler = createTestApp();
  const client = createClient<typeof handler>("http://fire.test/", {
    headers: () => headers("tenant-a", { id: "u1", role: "member" }),
    fetch: (input, init) => handler.request(input, init),
  });

  await expect(client.posts.add({ title: "", body: "x", authorId: "u1" })).rejects.toMatchObject({
    code: "VALIDATION",
    status: 400,
  });
});

test("storage.posts.add works as trusted admin API", async () => {
  const handler = createTestApp();
  const doc = await handler.storage.posts.add({
    title: "via storage",
    body: "trusted",
    authorId: "system",
  });
  expect(doc.title).toBe("via storage");

  const again = await handler.storage.posts.get(doc.id);
  expect(again?.body).toBe("trusted");
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
  const updated = await client.posts.update(created.id, { title: "t2" });
  expect(updated.title).toBe("t2");

  await client.posts.delete(created.id);
  expect(await client.posts.get(created.id)).toBeNull();
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
});
