import { expect, test } from "vite-plus/test";
import { BadRequestError, NotFoundError } from "@takibi/api";
import { decodePublicHttp, matchesPublicPrefix, MethodNotAllowedError } from "@takibi/worker-runtime";

test("matchesPublicPrefix uses path-segment boundaries", () => {
  expect(matchesPublicPrefix("/api/fire", "/api/fire")).toBe(true);
  expect(matchesPublicPrefix("/api/fire/posts", "/api/fire")).toBe(true);
  expect(matchesPublicPrefix("/api/firehose", "/api/fire")).toBe(false);
});

test("decodePublicHttp maps CRUD routes", async () => {
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts", {
        method: "POST",
        body: JSON.stringify({ title: "Hi" }),
      }),
      "/api/fire",
    ),
  ).resolves.toEqual({
    kind: "collection",
    collection: "posts",
    operation: "add",
    input: { title: "Hi" },
  });
  await expect(decodePublicHttp(new Request("http://fire.test/posts/p1"))).resolves.toEqual({
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "p1",
  });
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts?limit=10&cursor=abc")),
  ).resolves.toEqual({
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { limit: 10, cursor: "abc" },
  });
});

test("decodePublicHttp parses and normalizes list where JSON", async () => {
  const where = {
    op: "and",
    operands: [
      { field: "ownerId", op: "eq", value: "u1" },
      { field: "createdAt", op: "gte", value: "2026-08-15T00:00:00.000Z" },
    ],
  };
  const params = new URLSearchParams({ where: JSON.stringify(where) });

  await expect(
    decodePublicHttp(new Request(`http://fire.test/posts?${params.toString()}`)),
  ).resolves.toEqual({
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { where },
  });
});

test("decodePublicHttp parses indexed list query parameters", async () => {
  const where = { field: "ownerId", op: "eq", value: "u1" };
  const orderBy = { field: "createdAt", direction: "desc" };
  const params = new URLSearchParams({
    index: "byOwner",
    where: JSON.stringify(where),
    orderBy: JSON.stringify(orderBy),
  });
  await expect(
    decodePublicHttp(new Request(`http://fire.test/posts?${params.toString()}`)),
  ).resolves.toEqual({
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { index: "byOwner", where, orderBy },
  });
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts?orderBy=%7B%7D")),
  ).rejects.toThrow(/orderBy requires index/);
});

test("decodePublicHttp rejects malformed and excessive list queries", async () => {
  const leaf = { field: "score", op: "eq", value: 1 };
  let tooDeep: unknown = leaf;
  for (let index = 0; index < 8; index += 1) tooDeep = { op: "not", operand: tooDeep };
  const invalid = [
    "{",
    JSON.stringify({ field: "score", op: "wat", value: 1 }),
    JSON.stringify({ field: "score", op: "eq", value: 1, extra: true }),
    JSON.stringify({ field: "score", op: "eq", value: { nested: true } }),
    '{"field":"score","op":"eq","value":1e999}',
    JSON.stringify({ op: "and", operands: [leaf] }),
    JSON.stringify({ op: "and", operands: Array.from({ length: 32 }, () => leaf) }),
    JSON.stringify(tooDeep),
  ];

  for (const where of invalid) {
    const params = new URLSearchParams({ where });
    await expect(
      decodePublicHttp(new Request(`http://fire.test/posts?${params.toString()}`)),
    ).rejects.toBeInstanceOf(BadRequestError);
  }
});

test("decodePublicHttp maps collection and root colon actions", async () => {
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts:publish", {
        method: "POST",
        body: JSON.stringify({ id: "p1" }),
      }),
      "/api/fire",
    ),
  ).resolves.toEqual({
    kind: "action",
    scope: "posts",
    name: "publish",
    input: { id: "p1" },
  });
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/$:exportAll", { method: "POST" }),
      "/api/fire",
    ),
  ).resolves.toEqual({
    kind: "action",
    scope: "$",
    name: "exportAll",
  });
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/posts:nullable", {
        method: "POST",
        body: "null",
      }),
    ),
  ).resolves.toEqual({
    kind: "action",
    scope: "posts",
    name: "nullable",
    input: null,
  });
});

test("action routes treat a zero-length POST body as omitted input", async () => {
  const emptyBody = new Uint8Array();
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/posts/p1:archive", {
        method: "POST",
        body: emptyBody,
      }),
    ),
  ).resolves.toEqual({
    kind: "action",
    scope: "posts",
    name: "archive",
    id: "p1",
  });
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/posts:stats", {
        method: "POST",
        body: emptyBody,
      }),
    ),
  ).resolves.toEqual({
    kind: "action",
    scope: "posts",
    name: "stats",
  });
});

test("action routes reject methods, queries, malformed paths, and extra segments", async () => {
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts:stats")),
  ).rejects.toBeInstanceOf(MethodNotAllowedError);
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts:stats?limit=1", { method: "POST" })),
  ).rejects.toBeInstanceOf(BadRequestError);
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts:/x", { method: "POST" })),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts:", { method: "POST" })),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("CRUD rejects unknown methods and non-list query parameters", async () => {
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts", { method: "PUT" })),
  ).rejects.toBeInstanceOf(MethodNotAllowedError);
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts/p1?limit=1")),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("CRUD writes require a JSON body", async () => {
  for (const request of [
    new Request("http://fire.test/posts", { method: "POST" }),
    new Request("http://fire.test/posts/p1", { method: "PUT" }),
    new Request("http://fire.test/posts/p1", { method: "PATCH" }),
  ]) {
    await expect(decodePublicHttp(request)).rejects.toBeInstanceOf(BadRequestError);
  }
});

test("decodePublicHttp maps POST /_batch to a read-only batch request", async () => {
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/_batch", {
        method: "POST",
        body: JSON.stringify({
          kind: "batch",
          items: [
            { kind: "collection", collection: "posts", operation: "get", id: "p1" },
            {
              kind: "collection",
              collection: "posts",
              operation: "list",
              list: { limit: 2 },
            },
          ],
        }),
      }),
      "/api/fire",
    ),
  ).resolves.toEqual({
    kind: "batch",
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
      { kind: "collection", collection: "posts", operation: "list", list: { limit: 2 } },
    ],
  });
});

test("decodePublicHttp rejects non-POST, empty, oversized, nested, write, and action batches", async () => {
  await expect(decodePublicHttp(new Request("http://fire.test/_batch"))).rejects.toBeInstanceOf(
    MethodNotAllowedError,
  );
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/_batch", {
        method: "POST",
        body: JSON.stringify({ kind: "batch", items: [] }),
      }),
    ),
  ).rejects.toBeInstanceOf(BadRequestError);

  const tooMany = Array.from({ length: 21 }, (_, index) => ({
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: `p${index}`,
  }));
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/_batch", {
        method: "POST",
        body: JSON.stringify({ kind: "batch", items: tooMany }),
      }),
    ),
  ).rejects.toBeInstanceOf(BadRequestError);

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/_batch", {
        method: "POST",
        body: JSON.stringify({
          kind: "batch",
          items: [{ kind: "batch", items: [] }],
        }),
      }),
    ),
  ).rejects.toBeInstanceOf(BadRequestError);

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/_batch", {
        method: "POST",
        body: JSON.stringify({
          kind: "batch",
          items: [{ kind: "collection", collection: "posts", operation: "delete", id: "p1" }],
        }),
      }),
    ),
  ).rejects.toBeInstanceOf(BadRequestError);

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/_batch", {
        method: "POST",
        body: JSON.stringify({
          kind: "batch",
          items: [{ kind: "action", scope: "posts", name: "ping" }],
        }),
      }),
    ),
  ).rejects.toBeInstanceOf(BadRequestError);
});
