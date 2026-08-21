import { expect, test } from "vite-plus/test";
import { BadRequestError, NotFoundError } from "../src/errors";
import { decodePublicHttp, matchesPublicPrefix, MethodNotAllowedError } from "../src/http";

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
