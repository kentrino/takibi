import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { createClient, type ClientOf } from "../src";

const Post = z.object({ title: z.string() });
const DuplicateInput = z.object({ title: z.string() });
const CoercedInput = z.object({ value: z.number() });

type PostsCarrier = {
  readonly "~takibi": {
    readonly collections: {
      readonly posts: {
        readonly schema: typeof Post;
        readonly indexes: { readonly byTitle: readonly ["title"] };
      };
    };
    readonly actions: {
      readonly $: {
        readonly exportAll: {
          readonly inputSchema: undefined;
          readonly handler: () => Promise<{ ok: true }>;
        };
        readonly coerced: {
          readonly inputSchema: typeof CoercedInput;
          readonly handler: (args: { input: { value: number } }) => Promise<{ value: number }>;
        };
      };
      readonly posts: {
        readonly duplicate: {
          readonly target: "document";
          readonly inputSchema: typeof DuplicateInput;
          readonly handler: (args: { input: { title: string } }) => Promise<{ title: string }>;
        };
        readonly stats: {
          readonly inputSchema: undefined;
          readonly handler: () => Promise<{ count: number }>;
        };
        readonly ping: {
          readonly inputSchema: undefined;
          readonly handler: () => Promise<{ pong: true }>;
        };
      };
    };
  };
};

type FetchCall = {
  method: string;
  url: string;
  headerKeys: string[];
  headers: Record<string, string>;
  body?: unknown;
};

function captureFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: FetchCall = {
      method: request.method,
      url: request.url,
      headerKeys: [...request.headers.keys()],
      headers: Object.fromEntries(request.headers.entries()),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch: fetchImpl };
}

function ok(data: unknown = { id: "ok" }): Response {
  return Response.json({ ok: true, data });
}

function clientFor(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
) {
  return createClient<PostsCarrier>("http://fire.test/api/fire", { fetch });
}

test("CRUD methods construct exact URLs, methods, bodies, and query strings", async () => {
  const { calls, fetch } = captureFetch(() => ok({ id: "p1" }));
  const client = clientFor(fetch);

  await client.posts.add({ title: "first" }, { id: "p1" });
  await client.posts.set("p1", { title: "replaced" });
  await client.posts.get("p1");
  await client.posts.update("p1", { title: "patched" });
  await client.posts.delete("p1");
  await client.posts.list({
    limit: 5,
    cursor: "c1",
    index: "byTitle",
    where: (query) => query.title.eq("hello"),
    orderBy: (order) => order.title.asc(),
  });

  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "POST http://fire.test/api/fire/posts/p1",
    "PUT http://fire.test/api/fire/posts/p1",
    "GET http://fire.test/api/fire/posts/p1",
    "PATCH http://fire.test/api/fire/posts/p1",
    "DELETE http://fire.test/api/fire/posts/p1",
    "GET http://fire.test/api/fire/posts?limit=5&cursor=c1&where=%7B%22field%22%3A%22title%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22hello%22%7D&index=byTitle&orderBy=%7B%22field%22%3A%22title%22%2C%22direction%22%3A%22asc%22%7D",
  ]);
  expect(calls[0]?.body).toEqual({ title: "first" });
  expect(calls[1]?.body).toEqual({ title: "replaced" });
  expect(calls[2]).not.toHaveProperty("body");
  expect(calls[3]?.body).toEqual({ title: "patched" });
  expect(calls[4]).not.toHaveProperty("body");
  const listUrl = new URL(calls[5]!.url);
  expect(listUrl.searchParams.get("limit")).toBe("5");
  expect(listUrl.searchParams.get("cursor")).toBe("c1");
  expect(listUrl.searchParams.get("index")).toBe("byTitle");
  expect(JSON.parse(listUrl.searchParams.get("where")!)).toEqual({
    field: "title",
    op: "eq",
    value: "hello",
  });
  expect(JSON.parse(listUrl.searchParams.get("orderBy")!)).toEqual({
    field: "title",
    direction: "asc",
  });
});

test("root, detached collection, and document actions use exact request shapes", async () => {
  const { calls, fetch } = captureFetch(() => ok({ ok: true }));
  const client = clientFor(fetch);

  await client.posts.duplicate("p1", { title: "copy" });
  await client.posts.stats();
  await client.exportAll();
  await client.coerced({ value: 42 });

  expect(calls).toEqual([
    {
      method: "POST",
      url: "http://fire.test/api/fire/posts/p1:duplicate",
      headerKeys: ["content-type"],
      headers: { "content-type": "application/json" },
      body: { title: "copy" },
    },
    {
      method: "POST",
      url: "http://fire.test/api/fire/posts:stats",
      headerKeys: [],
      headers: {},
    },
    {
      method: "POST",
      url: "http://fire.test/api/fire/$:exportAll",
      headerKeys: [],
      headers: {},
    },
    {
      method: "POST",
      url: "http://fire.test/api/fire/$:coerced",
      headerKeys: ["content-type"],
      headers: { "content-type": "application/json" },
      body: { value: 42 },
    },
  ]);
});

test("document action ids containing colons are encoded as %3A on the wire", async () => {
  const { calls, fetch } = captureFetch(() => ok({ audits: 1 }));
  const client = createClient<PostsCarrier>("http://fire.test", { fetch });
  await client.posts.duplicate("a:b", { title: "copy" });
  expect(calls.at(-1)?.url).toBe("http://fire.test/posts/a%3Ab:duplicate");
});

test("trailing slashes on the base URL are stripped", async () => {
  const { calls, fetch } = captureFetch(() => ok());
  const client = createClient<PostsCarrier>("http://fire.test/api/", { fetch });
  await client.posts.get("p1");
  expect(calls[0]?.url).toBe("http://fire.test/api/posts/p1");
});

test("success, operation failure, and validation failure decode the envelope", async () => {
  const { fetch } = captureFetch((call) => {
    if (call.url.endsWith("/ok")) {
      return Response.json({ ok: true, data: { id: "p1", title: "n" } });
    }
    if (call.url.endsWith("/missing")) {
      return Response.json({
        ok: false,
        error: {
          kind: "operation",
          code: "NOT_FOUND",
          message: "Not found",
          status: 404,
        },
      });
    }
    return Response.json({
      ok: false,
      error: {
        kind: "validation",
        code: "VALIDATION",
        message: "invalid",
        status: 400,
        issues: [{ message: "title", path: ["title"] }],
      },
    });
  });
  const client = createClient<PostsCarrier>("http://fire.test", { fetch });

  await expect(client.posts.get("ok")).resolves.toEqual({
    ok: true,
    data: { id: "p1", title: "n" },
  });
  await expect(client.posts.get("missing")).resolves.toEqual({
    ok: false,
    error: {
      kind: "operation",
      code: "NOT_FOUND",
      message: "Not found",
      status: 404,
    },
  });
  await expect(client.posts.add({ title: "" })).resolves.toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
});

test("malformed envelopes and non-JSON responses reject instead of returning ok", async () => {
  const malformed = captureFetch(() => Response.json({ unexpected: true }));
  const broken = captureFetch(() => new Response("not-json"));
  const malformedClient = createClient<PostsCarrier>("http://fire.test", {
    fetch: malformed.fetch,
  });
  const brokenClient = createClient<PostsCarrier>("http://fire.test", { fetch: broken.fetch });

  await expect(malformedClient.posts.get("p1")).rejects.toThrow(/Invalid response envelope/);
  await expect(brokenClient.posts.get("p1")).rejects.toThrow();
});

test("static, getter, and async header providers attach to every request", async () => {
  const { calls, fetch } = captureFetch(() => ok());
  const staticClient = createClient<PostsCarrier>("http://fire.test", {
    headers: { authorization: "Bearer static" },
    fetch,
  });
  await staticClient.posts.get("p1");
  expect(calls[0]?.headers.authorization).toBe("Bearer static");

  let reads = 0;
  const getterClient = createClient<PostsCarrier>("http://fire.test", {
    headers: () => {
      reads += 1;
      return { authorization: `Bearer ${reads}` };
    },
    fetch,
  });
  await getterClient.posts.get("p2");
  await getterClient.posts.get("p3");
  expect(reads).toBe(2);
  expect(calls[1]?.headers.authorization).toBe("Bearer 1");
  expect(calls[2]?.headers.authorization).toBe("Bearer 2");

  const asyncClient = createClient<PostsCarrier>("http://fire.test", {
    headers: async () => ({ authorization: "Bearer async" }),
    fetch,
  });
  await asyncClient.posts.add({ title: "n" });
  expect(calls[3]?.headers.authorization).toBe("Bearer async");
  expect(calls[3]?.headers["content-type"]).toBe("application/json");
});

test("caller content-type is preserved and custom fetch receives the constructed request", async () => {
  const { calls, fetch } = captureFetch(() => ok());
  const client = createClient<PostsCarrier>("http://fire.test", {
    headers: { "content-type": "application/vnd.takibi+json" },
    fetch,
  });
  await client.posts.add({ title: "n" });
  expect(calls[0]?.headers["content-type"]).toBe("application/vnd.takibi+json");
  expect(calls[0]?.method).toBe("POST");
});

test("empty document ids fail locally without calling fetch", async () => {
  let calls = 0;
  const client = createClient<PostsCarrier>("http://fire.test", {
    fetch: () => {
      calls += 1;
      return ok();
    },
  });
  await expect(client.posts.get("")).resolves.toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  await expect(client.posts.duplicate("", { title: "copy" })).resolves.toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
  expect(calls).toBe(0);
});

test("non-JSON action input is rejected before fetch", async () => {
  let calls = 0;
  const client = createClient<PostsCarrier>("http://fire.test", {
    fetch: () => {
      calls += 1;
      return ok();
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

test("reflection and unsafe proxy properties never become network endpoints", async () => {
  let calls = 0;
  const client = createClient<PostsCarrier>("http://fire.test", {
    fetch: () => {
      calls += 1;
      return ok();
    },
  });
  expect(JSON.stringify(client)).toBe("{}");
  await expect(Promise.resolve(client)).resolves.toBe(client);
  expect(Reflect.get(client, "__proto__")).toBeUndefined();
  expect(Reflect.get(client.posts, "constructor")).toBeUndefined();
  expect(Reflect.get(client.posts, "bind")).toBeUndefined();
  expect(Reflect.get(client.posts, "then")).toBeUndefined();
  expect(calls).toBe(0);
});

test("client collections do not expose count, updateMany, or deleteMany", () => {
  const client = createClient<PostsCarrier>("http://fire.test");
  expectTypeOf(client.posts).not.toHaveProperty("count");
  expectTypeOf(client.posts).not.toHaveProperty("updateMany");
  expectTypeOf(client.posts).not.toHaveProperty("deleteMany");
  expectTypeOf<ClientOf<PostsCarrier>["posts"]>().not.toHaveProperty("count");
  expectTypeOf<ClientOf<PostsCarrier>["posts"]>().not.toHaveProperty("updateMany");
  expectTypeOf<ClientOf<PostsCarrier>["posts"]>().not.toHaveProperty("deleteMany");
});

test("list option compilation rejects empty and oversized in() lists before fetch", () => {
  let calls = 0;
  const client = createClient<PostsCarrier>("http://fire.test", {
    fetch: () => {
      calls += 1;
      return ok({ items: [] });
    },
  });
  expect(() => client.posts.list({ where: (query) => query.title.in([]) })).toThrow(
    /between 1 and 32/,
  );
  expect(() =>
    client.posts.list({
      where: (query) => query.title.in(Array.from({ length: 33 }, (_, index) => `title-${index}`)),
    }),
  ).toThrow(/between 1 and 32/);
  expect(calls).toBe(0);
});
