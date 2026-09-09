import { requestTakibi } from "./helpers/request";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createClient } from "@takibi/takibi/client";
import { withSqliteTestBackend } from "@takibi/takibi/testing";
import { ListAllLimitError, createTakibi, fullAccess, grant, none } from "../src/index";
import { LIST_ALL_PAGE_SIZE_DEFAULT, LIST_PAGE_MAX } from "../src/list-all";

type AppCtx = { tenantId: string; user: { id: string } | null };

function resolveTestContext({ request }: { request: Request }): AppCtx {
  const raw = request.headers.get("x-test-user");
  return {
    tenantId: request.headers.get("x-test-tenant") ?? "tenant-a",
    user: raw ? (JSON.parse(raw) as { id: string }) : { id: "u1" },
  };
}

const Post = z.object({ title: z.string(), published: z.boolean().default(true) });

function sqliteHandler(accessPolicy = fullAccess) {
  const production = createTakibi()({ resolve: resolveTestContext })
    .defineCollections({ posts: { schema: Post, accessPolicy } })
    .actions({});
  return withSqliteTestBackend(production);
}

function clientFor(
  handler: ReturnType<typeof sqliteHandler>,
  options: Parameters<typeof createClient>[1] = {},
) {
  return createClient<typeof handler>("http://takibi.test", {
    headers: () => ({ "x-test-tenant": "tenant-a", "x-test-user": JSON.stringify({ id: "u1" }) }),
    fetch: (input, init) => requestTakibi(handler, input, init),
    ...options,
  });
}

async function seedPosts(
  client: ReturnType<typeof clientFor>,
  titles: readonly string[],
): Promise<void> {
  for (const [index, title] of titles.entries()) {
    const created = await client.posts.add(
      { title },
      { id: `p${String(index + 1).padStart(2, "0")}` },
    );
    expect(created.ok).toBe(true);
  }
}

test("listAll follows list cursors and returns every matching document", async () => {
  const client = clientFor(sqliteHandler());
  await seedPosts(client, ["a", "b", "c", "d", "e"]);

  const listed = await client.posts.listAll({ pageSize: 2 });
  expect(listed).toMatchObject({ ok: true });
  if (!listed.ok) return;
  expect(listed.data.map((post) => post.title)).toEqual(["a", "b", "c", "d", "e"]);
});

test("listAll forwards where to every page", async () => {
  const client = clientFor(sqliteHandler());
  await seedPosts(client, ["keep", "drop", "keep"]);
  await client.posts.update("p02", { published: false });

  const listed = await client.posts.listAll({
    pageSize: 1,
    where: (query) => query.published.eq(true),
  });
  expect(listed).toMatchObject({ ok: true });
  if (!listed.ok) return;
  expect(listed.data.map((post) => post.title)).toEqual(["keep", "keep"]);
});

test("listAll fails with LIST_ALL_LIMIT when matching documents remain", async () => {
  const client = clientFor(sqliteHandler(), { listAll: { maxItems: 3, pageSize: 2 } });
  await seedPosts(client, ["a", "b", "c", "d"]);

  const listed = await client.posts.listAll();
  expect(listed).toMatchObject({
    ok: false,
    error: {
      kind: "operation",
      code: "LIST_ALL_LIMIT",
      status: 400,
    },
  });
});

test("listAll succeeds when the collection fits exactly in maxItems", async () => {
  const client = clientFor(sqliteHandler(), { listAll: { maxItems: 3, pageSize: 2 } });
  await seedPosts(client, ["a", "b", "c"]);

  const listed = await client.posts.listAll();
  expect(listed).toMatchObject({ ok: true });
  if (!listed.ok) return;
  expect(listed.data).toHaveLength(3);
});

test("listAll uses the same list policy on every page", async () => {
  const denied = clientFor(sqliteHandler(none));
  const listed = await denied.posts.listAll();
  expect(listed).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });

  const getOnly = clientFor(sqliteHandler(grant("get")));
  const stillDenied = await getOnly.posts.listAll();
  expect(stillDenied).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "FORBIDDEN", status: 403 },
  });
});

test("trusted $collections.listAll follows cursors and throws ListAllLimitError", async () => {
  const context = createTakibi()({ resolve: resolveTestContext });
  const app = context.defineCollections({
    posts: { schema: Post, accessPolicy: fullAccess },
  });
  const production = app.actions({
    posts: app.posts.actions((defineAction) => ({
      titles: defineAction()
        .detached()
        .policy(fullAccess)
        .handler(async ({ $collection }) => {
          const docs = await $collection.listAll({ pageSize: 2 });
          return { titles: docs.map((post) => post.title) };
        }),
      capped: defineAction()
        .detached()
        .policy(fullAccess)
        .handler(async ({ $collection }) => $collection.listAll({ pageSize: 2, maxItems: 3 })),
    })),
  });
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof handler>("http://takibi.test", {
    headers: () => ({ "x-test-tenant": "tenant-a" }),
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  await seedPosts(client, ["a", "b", "c", "d"]);

  const titles = await client.posts.titles();
  expect(titles).toMatchObject({ ok: true, data: { titles: ["a", "b", "c", "d"] } });

  const capped = await client.posts.capped();
  expect(capped).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "LIST_ALL_LIMIT", status: 400 },
  });
});

test("createClient rejects invalid listAll caps", () => {
  const handler = sqliteHandler();
  expect(() =>
    createClient<typeof handler>("http://takibi.test", { listAll: { pageSize: 0 } }),
  ).toThrow(TypeError);
  expect(() =>
    createClient<typeof handler>("http://takibi.test", {
      listAll: { pageSize: LIST_PAGE_MAX + 1 },
    }),
  ).toThrow(TypeError);
  expect(() =>
    createClient<typeof handler>("http://takibi.test", { listAll: { maxItems: 0 } }),
  ).toThrow(TypeError);
});

test("listAll call-site caps cannot exceed createClient caps", async () => {
  const client = clientFor(sqliteHandler(), { listAll: { maxItems: 5, pageSize: 10 } });
  expect(() => client.posts.listAll({ maxItems: 6 })).toThrow(TypeError);
  expect(() => client.posts.listAll({ pageSize: 11 })).toThrow(TypeError);
  expect(() => client.posts.listAll({ pageSize: LIST_ALL_PAGE_SIZE_DEFAULT })).toThrow(TypeError);
});

test("ListAllLimitError constructs the public operation failure", () => {
  expect(new ListAllLimitError(4)).toMatchObject({
    name: "ListAllLimitError",
    code: "LIST_ALL_LIMIT",
    status: 400,
  });
});
