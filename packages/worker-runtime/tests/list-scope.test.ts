import { afterEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import { createDurableObjectStorage, compileIndexRegistry } from "@takibi/storage";
import { grant, none, read, fullAccess } from "@takibi/policy";
import { createTakibi } from "@takibi/worker-runtime";
import { createClient } from "@takibi/client";
import { withSqliteTestBackend } from "@takibi/testing";
import { requestTakibi } from "./helpers/request";
import type { AccessContext } from "@takibi/policy";
import { compileWhere, listWhere } from "@takibi/query";
import { decodeWireRequest } from "@takibi/protocol";
import type { CollectionsDef } from "@takibi/api";
import { TakibiError } from "@takibi/api";
import {
  executeOperation,
  executeResolvedCollection,
  createPolicyCollections,
  createTrustedCollections,
} from "../src/executor";

const schema = z.object({ owner: z.string(), title: z.string() });

test("public HTTP and root actions share owner ranges and sanitize callback failures", async () => {
  const calls = vi.fn();
  const context = createTakibi()({
    resolve: ({ request }) => ({ tenantId: "scope-http", user: request.headers.get("x-user") }),
  });
  const app = context.defineCollections({
    posts: {
      schema,
      seed: () => ({
        a: { owner: "a", title: "visible" },
        b: { owner: "b", title: "visible" },
        c: { owner: "a", title: "visible" },
      }),
      accessPolicy: ({ user, where }) => {
        calls(where);
        if (!user) return none;
        return grant(
          listWhere<z.infer<typeof schema>>((q) => {
            if (user === "broken") throw new TakibiError("SECRET", "private predicate", 400);
            return q.owner.eq(user);
          }),
        );
      },
    },
  });
  const summary = app
    .defineAction()
    .policy(fullAccess)
    .handler(async ({ collections, $collections }) => ({
      visible: (await collections.posts.list()).items.map((p) => p.id),
      count: await collections.posts.count(),
      trustedCount: await $collections.posts.count(),
    }));
  const handler = withSqliteTestBackend(app.actions({ $: { summary } }));
  const client = createClient<typeof handler>("http://scope.test", {
    headers: { "x-user": "a" },
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  const page = await client.posts.list({ where: (q) => q.title.eq("visible"), limit: 1 });
  expect(page.ok).toBe(true);
  if (!page.ok) throw new Error("Expected authorized page");
  expect(page.data.items.map((p) => p.id)).toEqual(["a"]);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(calls.mock.calls[0]![0]).toEqual({ field: "title", op: "eq", value: "visible" });
  expect(await client.summary()).toEqual({
    ok: true,
    data: { visible: ["a", "c"], count: 2, trustedCount: 3 },
  });
  const denied = await requestTakibi(handler, "http://scope.test/posts");
  expect(denied.status).toBe(403);
  const broken = await requestTakibi(handler, "http://scope.test/posts", {
    headers: { "x-user": "broken" },
  });
  expect(broken.status).toBe(500);
  const body = await broken.text();
  expect(body).toContain("INVALID_LIST_SCOPE");
  expect(body).not.toContain("private predicate");
});
type Post = z.infer<typeof schema>;
type Context = { user: string | null; admin?: boolean };
const databases: ReturnType<typeof createSqliteDurableObjectStorage>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture(size = 5) {
  const db = createSqliteDurableObjectStorage();
  databases.push(db);
  const owner = vi.fn((ctx: AccessContext<Context>) =>
    ctx.user ? grant(listWhere<Post>((q) => q.owner.eq(ctx.user!))) : none,
  );
  const definitions: CollectionsDef<Context> = {
    posts: { schema, accessPolicy: (ctx) => (ctx.admin ? read : owner(ctx)) },
  };
  const storage = createDurableObjectStorage(
    db,
    compileIndexRegistry({
      posts: { indexes: { byOwner: ["owner", "createdAt"] as const } },
    }),
  );
  for (let i = 0; i < size; i++)
    await storage.put("posts", {
      id: String(i).padStart(4, "0"),
      owner: i % 2 === 0 ? "a" : "b",
      title: "visible",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      rev: 1,
    });
  return { definitions, storage, owner };
}

test("policy-bound list/count intersect view filters, preserve requested context and bypass trusted policy", async () => {
  const { definitions, storage, owner } = await fixture(403);
  const api = createPolicyCollections(definitions, storage, { user: "a" }).posts;
  const where = compileWhere<Post>((q) => q.title.eq("visible"));
  const decoded = decodeWireRequest({
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { where, limit: 2 },
    context: {},
  });
  if (decoded.kind !== "collection") throw new Error("Expected collection");
  const page = (await executeOperation(definitions, storage, { user: "a" }, decoded)) as {
    items: Record<string, unknown>[];
    nextCursor?: string;
  };
  expect(page.items).toHaveLength(2);
  expect(page.items.every((p) => p.owner === "a")).toBe(true);
  expect(owner).toHaveBeenCalledTimes(1);
  expect(owner.mock.calls[0]![0].where).toEqual(where);
  owner.mockClear();
  expect(await api.count()).toBe(202);
  expect(owner).toHaveBeenCalledTimes(1); // count spans two internal storage pages
  expect(owner.mock.calls[0]![0].where).toBeUndefined();
  const indexed = await api.list({ index: "byOwner", limit: 2 });
  expect(indexed.items.every((p) => p.owner === "a")).toBe(true);
  expect(await api.count({ index: "byOwner" })).toBe(202);
  expect((await api.list({ where: (q) => q.owner.eq("b") })).items).toEqual([]);
  const admin = createPolicyCollections(definitions, storage, { user: "a", admin: true }).posts;
  expect(await admin.count()).toBe(403);
  owner.mockClear();
  expect(await createTrustedCollections(definitions, storage).posts.count()).toBe(403);
  expect(owner).not.toHaveBeenCalled();
  await expect(
    createPolicyCollections(definitions, storage, { user: null }).posts.list(),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("continuations reauthorize, bind the effective AST and omit server predicates", async () => {
  const { definitions, storage, owner } = await fixture();
  const api = createPolicyCollections(definitions, storage, { user: "a" }).posts;
  const first = await api.list({ limit: 1 });
  const token = JSON.parse(
    atob(first.nextCursor!.replaceAll("-", "+").replaceAll("_", "/")),
  ) as Record<string, unknown>;
  expect(token).toMatchObject({ v: 4, requestedWhere: null });
  expect(token).not.toHaveProperty("where");
  expect(JSON.stringify(token)).not.toContain('"owner"');
  const second = await api.list({ limit: 1, cursor: first.nextCursor });
  expect(second.items[0]!.id).toBe("0002");
  expect(owner).toHaveBeenCalledTimes(2);
  await expect(
    createPolicyCollections(definitions, storage, { user: "b" }).posts.list({
      cursor: first.nextCursor,
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    api.list({ cursor: first.nextCursor, where: (q) => q.title.eq("visible") }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // A distinct context with the same effective AST can reuse the cursor.
  expect(
    (
      await createPolicyCollections(definitions, storage, { user: "a", admin: false }).posts.list({
        cursor: first.nextCursor,
      })
    ).items.every((p) => p.owner === "a"),
  ).toBe(true);
});

test("scope failures are safe server errors before storage in policy-bound actions", async () => {
  const { definitions, storage } = await fixture();
  const scan = vi.spyOn(storage, "list");
  const broken = {
    posts: {
      ...definitions.posts,
      accessPolicy: () =>
        grant(
          listWhere<Post>(() => {
            throw new TakibiError("LEAK", "secret-value", 400);
          }),
        ),
    },
  };
  await expect(createPolicyCollections(broken, storage, {}).posts.list()).rejects.toMatchObject({
    code: "INVALID_LIST_SCOPE",
    status: 500,
    message: "Invalid list authorization scope",
  });
  expect(scan).not.toHaveBeenCalled();
  const wide = listWhere<Post>((q) =>
    q.and(q.owner.eq("a"), q.owner.eq("a"), ...Array.from({ length: 29 }, () => q.owner.eq("a"))),
  );
  const overflow = { posts: { ...definitions.posts, accessPolicy: () => grant(wide) } };
  await expect(
    createPolicyCollections(overflow, storage, {}).posts.count({
      where: (q) =>
        q.and(
          q.title.eq("visible"),
          q.title.eq("visible"),
          ...Array.from({ length: 29 }, () => q.title.eq("visible")),
        ),
    }),
  ).rejects.toMatchObject({ code: "INVALID_LIST_SCOPE", status: 500 });
  expect(scan).not.toHaveBeenCalled();
});

test("wire decoders reject server-only query metadata and keep client limits", () => {
  const request = { kind: "collection", collection: "posts", operation: "list", context: {} };
  expect(() => decodeWireRequest({ ...request, list: { requestedWhere: null } })).toThrow();
  const leaf = { field: "title", op: "eq", value: "visible" };
  expect(() =>
    decodeWireRequest({
      ...request,
      list: { where: { op: "and", operands: Array(32).fill(leaf) } },
    }),
  ).toThrow();
});

test("unresolved list operations cannot fall back to unrestricted storage", async () => {
  const { definitions, storage } = await fixture();
  const scan = vi.spyOn(storage, "list");
  await expect(
    executeResolvedCollection({
      req: { kind: "collection", collection: "posts", operation: "list" },
      ctx: { user: "a" },
      def: definitions.posts!,
      collections: definitions,
      storage,
      grant: grant(listWhere<Post>((q) => q.owner.eq("a"))),
    }),
  ).rejects.toMatchObject({ code: "INVALID_LIST_SCOPE", status: 500 });
  expect(scan).not.toHaveBeenCalled();
});
