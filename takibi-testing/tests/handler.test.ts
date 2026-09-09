import { createClient } from "@takibi/takibi-client";
import { fullAccess, none } from "@takibi/takibi-policy";
import { createDurableObjectStorage } from "@takibi/takibi-storage";
import { createTakibi } from "@takibi/takibi-worker-runtime";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "../src";
import { createSqliteDurableObjectStorage } from "../src/sqlite-storage.server";

type User = { id: string; role: "admin" | "guest" };

function headers(role: User["role"] = "admin"): Headers {
  return new Headers({ "x-role": role });
}

test("SQLite test backend runs CRUD, actions, policies, unique constraints, and indexes", async () => {
  const context = createTakibi()({
    resolve: ({ request }) => ({
      tenantId: "tenant-a",
      user: { id: "u1", role: (request.headers.get("x-role") ?? "guest") as User["role"] },
    }),
  });
  const app = context.defineCollections({
    posts: {
      schema: z.object({ title: z.string(), authorId: z.string() }),
      accessPolicy: ({ user }) => (user.role === "admin" ? fullAccess : none),
      unique: { byTitle: ["title"] },
      indexes: { byAuthor: ["authorId"] },
      seed: () => ({ seeded: { title: "seeded", authorId: "u1" } }),
    },
  });
  const ping = app
    .defineAction()
    .policy(fullAccess)
    .handler(({ ctx }) => ({ by: ctx.user.id }));
  const handler = withSqliteTestBackend(app.actions({ $: { ping } }));
  const admin = createClient<typeof handler>("https://takibi.test", {
    headers: () => headers("admin"),
    fetch: (input, init) => handler.request(input, init),
  });
  const guest = createClient<typeof handler>("https://takibi.test", {
    headers: () => headers("guest"),
    fetch: (input, init) => handler.request(input, init),
  });

  await expect(admin.posts.get("seeded")).resolves.toMatchObject({
    ok: true,
    data: { title: "seeded", authorId: "u1" },
  });
  const created = await admin.posts.add({ title: "live", authorId: "u1" }, { id: "p1" });
  expect(created).toMatchObject({ ok: true, data: { id: "p1", title: "live" } });
  await expect(
    admin.posts.add({ title: "live", authorId: "u2" }, { id: "p2" }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "ALREADY_EXISTS", status: 409 },
  });
  const listed = await admin.posts.list({
    index: "byAuthor",
    where: (query) => query.authorId.eq("u1"),
  });
  expect(listed).toMatchObject({ ok: true });
  if (listed.ok) {
    expect(listed.data.items.map((item) => item.id).sort()).toEqual(["p1", "seeded"]);
  }
  await expect(admin.ping()).resolves.toMatchObject({ ok: true, data: { by: "u1" } });
  await expect(guest.posts.get("p1")).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  handler[Symbol.dispose]();
});

test("SQLite-backed handler Durable Object applies migrations on read", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const handler = context
    .defineCollections({
      settings: {
        schema: z.object({ label: z.string(), enabled: z.boolean() }),
        migrations: {
          steps: [
            (data) => ({ ...(data as { name: string }), label: (data as { name: string }).name }),
            (data) => {
              const { name: _name, ...rest } = data as { name: string; label: string };
              return { ...rest, enabled: true };
            },
          ],
        },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const storage = createSqliteDurableObjectStorage();
  const durable = createDurableObjectStorage(storage);
  await durable.put("settings", {
    id: "default",
    name: "Clinic",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  } as never);
  const object = new handler.DurableObject(
    {
      storage,
      id: { name: "tenant-a" },
      blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
        return callback();
      },
    } as unknown as DurableObjectState,
    {},
  );
  await expect(object.$collections.settings.get("default")).resolves.toMatchObject({
    id: "default",
    label: "Clinic",
    enabled: true,
  });
  storage.close();
});

test("SQLite-backed handler Durable Object exports and restores a snapshot", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "snapshot" }) });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({ email: z.string().email(), score: z.number() }),
        accessPolicy: fullAccess,
        unique: { byEmail: ["email"] },
        indexes: { byScore: ["score"] },
      },
    })
    .actions({});
  const object = new handler.DurableObject(
    {
      storage: createSqliteDurableObjectStorage(),
      id: { name: "snapshot" },
      blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
        return callback();
      },
    } as unknown as DurableObjectState,
    {},
  );
  await object.$collections.records.add({ email: "one@example.test", score: 1 }, { id: "r1" });
  const encoded = await new Response(await object.$collections.$exportSnapshot()).text();
  expect(encoded).toContain("one@example.test");
  await object.$collections.records.add({ email: "two@example.test", score: 2 }, { id: "r2" });
  await object.$collections.$restoreSnapshot(
    new Blob([encoded]).stream() as ReadableStream<Uint8Array>,
  );
  await expect(object.$collections.records.get("r1")).resolves.toMatchObject({
    email: "one@example.test",
  });
  await expect(object.$collections.records.get("r2")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("action handler receives SQLite test backend services and keeps production resolve", async () => {
  type Initial = { token: string };
  const seen: Initial[] = [];
  const context = createTakibi.withInitial<Initial>()({
    resolve: ({ context: initial }) => {
      seen.push(initial);
      return { tenantId: "tenant-a" };
    },
    services: () => ({ stamp: "from-factory" }),
  });
  const app = context.defineCollections({
    posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
  });
  const production = app.actions({
    $: {
      ping: app
        .defineAction()
        .policy(fullAccess)
        .handler(({ services }) => ({ stamp: services.stamp })),
    },
  });
  const handler = withSqliteTestBackend(production, { services: { stamp: "from-sqlite-test" } });
  const client = createClient<typeof handler>("https://takibi.test", {
    fetch: async (input, init) => {
      const result = await handler.handle(new Request(input, init), {
        context: { token: "action-session" },
      });
      if (!result.matched) throw new Error("Expected a matching request");
      return result.response;
    },
  });
  await expect(client.ping()).resolves.toMatchObject({
    ok: true,
    data: { stamp: "from-sqlite-test" },
  });
  const result = await handler.handle(new Request("https://takibi.test/posts/missing"), {
    context: { token: "session-1" },
  });
  expect(result.matched).toBe(true);
  expect(seen.at(-1)).toEqual({ token: "session-1" });
  handler[Symbol.dispose]();
});

test("MISSING_SERVICES is thrown at SQLite test backend assembly", () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    services: () => ({ stamp: "x" }),
  });
  const production = context
    .defineCollections({
      posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
    })
    .actions({});
  expect(() =>
    // @ts-expect-error SQLite test backend requires services
    withSqliteTestBackend(production),
  ).toThrow(
    expect.objectContaining({
      code: "MISSING_SERVICES",
    }),
  );
});
