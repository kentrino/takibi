import { expect, test } from "vite-plus/test";
import { BadRequestError, NotFoundError } from "../src/errors";
import { decodePublicHttp, matchesPublicPrefix, MethodNotAllowedError } from "../src/http";

test("matchesPublicPrefix is a path-segment boundary", () => {
  expect(matchesPublicPrefix("/api/fire", "/api/fire")).toBe(true);
  expect(matchesPublicPrefix("/api/fire/", "/api/fire")).toBe(true);
  expect(matchesPublicPrefix("/api/fire/posts", "/api/fire")).toBe(true);
  expect(matchesPublicPrefix("/api/fire/posts/id", "/api/fire")).toBe(true);
  expect(matchesPublicPrefix("/api/firehose", "/api/fire")).toBe(false);
  expect(matchesPublicPrefix("/other", "/api/fire")).toBe(false);
  expect(matchesPublicPrefix("/posts", undefined)).toBe(true);
});

test("decodePublicHttp maps the six REST routes", async () => {
  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hi" }),
      }),
      "/api/fire",
    ),
  ).resolves.toEqual({ resource: "posts", operation: "add", input: { title: "Hi" } });

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts/p1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hi" }),
      }),
      "/api/fire",
    ),
  ).resolves.toEqual({
    resource: "posts",
    operation: "set",
    id: "p1",
    input: { title: "Hi" },
  });

  await expect(
    decodePublicHttp(new Request("http://fire.test/api/fire/posts/p1"), "/api/fire"),
  ).resolves.toEqual({ resource: "posts", operation: "get", id: "p1" });

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts/p1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Hi" }),
      }),
      "/api/fire",
    ),
  ).resolves.toEqual({
    resource: "posts",
    operation: "update",
    id: "p1",
    input: { title: "Hi" },
  });

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts/p1", { method: "DELETE" }),
      "/api/fire",
    ),
  ).resolves.toEqual({ resource: "posts", operation: "delete", id: "p1" });

  await expect(
    decodePublicHttp(
      new Request("http://fire.test/api/fire/posts?limit=10&cursor=abc"),
      "/api/fire",
    ),
  ).resolves.toEqual({
    resource: "posts",
    operation: "list",
    list: { limit: 10, cursor: "abc" },
  });
});

test("decodePublicHttp rejects extra segments, unknown methods, and non-list query", async () => {
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts/p1/extra"), undefined),
  ).rejects.toBeInstanceOf(NotFoundError);

  await expect(
    decodePublicHttp(new Request("http://fire.test/posts", { method: "PUT" }), undefined),
  ).rejects.toBeInstanceOf(MethodNotAllowedError);

  await expect(
    decodePublicHttp(new Request("http://fire.test/posts/p1?limit=1"), undefined),
  ).rejects.toBeInstanceOf(BadRequestError);

  await expect(
    decodePublicHttp(new Request("http://fire.test/posts?foo=1"), undefined),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("decodePublicHttp decodes encoded resource and id segments", async () => {
  await expect(
    decodePublicHttp(new Request("http://fire.test/posts/2026-01-01%2Fholiday")),
  ).resolves.toEqual({
    resource: "posts",
    operation: "get",
    id: "2026-01-01/holiday",
  });
});
