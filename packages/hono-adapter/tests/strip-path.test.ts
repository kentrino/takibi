import { Hono } from "hono";
import { basePath } from "hono/route";
import { expect, test } from "vite-plus/test";
import { stripPath } from "../src/strip-path";

test.each([
  { base: "", path: "/", expected: "/" },
  { base: "/", path: "/", expected: "/" },
  { base: "", path: "/posts/a%3Ab", expected: "/posts/a%3Ab" },
  { base: "/", path: "/posts/a%3Ab/", expected: "/posts/a%3Ab/" },
  { base: "/api", path: "/api", expected: "/" },
  { base: "/api", path: "/api/", expected: "/" },
  { base: "/api", path: "/api/posts", expected: "/posts" },
  { base: "/api", path: "/api/posts/", expected: "/posts/" },
  { base: "/api", path: "/api/posts//id", expected: "/posts//id" },
  { base: "/api", path: "/api//posts", expected: "//posts" },
  { base: "/orgs/acme/api", path: "/orgs/acme/api/_batch", expected: "/_batch" },
  { base: "/api/日本", path: "/api/%E6%97%A5%E6%9C%AC/posts", expected: "/posts" },
  { base: "/api/😀", path: "/api/%F0%9F%98%80/posts", expected: "/posts" },
  { base: "/api/a%2Fb", path: "/api/a%2Fb/posts", expected: "/posts" },
  { base: "/api/a%2fb", path: "/api/a%2fb/posts", expected: "/posts" },
  { base: "/api/a%25b", path: "/api/a%25b/posts", expected: "/posts" },
  { base: "/api", path: "/api/posts/a%2Fb", expected: "/posts/a%2Fb" },
  { base: "/api", path: "/api/posts/a%252Fb", expected: "/posts/a%252Fb" },
  { base: "/api", path: "/api/posts/a%3Ab:inspect", expected: "/posts/a%3Ab:inspect" },
  { base: "/api", path: "/api/posts/a%3ab%3Ainspect", expected: "/posts/a%3ab%3Ainspect" },
  { base: "/api", path: "/api/posts/%e6%97%a5", expected: "/posts/%e6%97%a5" },
  { base: "/api", path: "/api/posts/%ZZ", expected: "/posts/%ZZ" },
])("strips $base from $path without changing the remainder", ({ base, path, expected }) => {
  expect(stripPath({ base, path })).toBe(expected);
});

// Use actual Hono basePath values to cover its decoding and mount composition.
test.each([
  { mount: "/api", prefix: "/api" },
  { mount: "/api", prefix: "/%61pi" },
  { mount: "/日本", prefix: "/%E6%97%A5%E6%9C%AC" },
  { mount: "/api/:room", prefix: "/api/%E6%97%A5%E6%9C%AC" },
  { mount: "/api/:room", prefix: "/api/a%2Fb" },
  { mount: "/api/:room", prefix: "/api/a%25b" },
  { mount: "/api/:room", prefix: "/api/a%252Fb" },
])("preserves raw paths under Hono mount $mount at $prefix", async ({ mount, prefix }) => {
  const server = new Hono().use("*", async (c) =>
    c.text(stripPath({ base: basePath(c), path: new URL(c.req.raw.url).pathname })),
  );
  const app = new Hono().route("/orgs/:org", new Hono().route(mount, server));
  for (const remainder of ["", "/", "/posts/a%3Ab:inspect", "/posts/%E6%97%A5%2F%25/"]) {
    const response = await app.request(`/orgs/%E6%97%A5/${prefix.slice(1)}${remainder}?limit=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(remainder || "/");
  }
});
