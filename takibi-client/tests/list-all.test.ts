import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { LIST_ALL_PAGE_SIZE_DEFAULT, LIST_PAGE_MAX } from "@takibi/takibi-api";
import { createClient } from "../src";

const Post = z.object({ title: z.string() });

type PostsCarrier = {
  readonly "~takibi": {
    readonly collections: {
      readonly posts: { readonly schema: typeof Post };
    };
  };
};

test("createClient rejects invalid listAll caps", () => {
  expect(() =>
    createClient<PostsCarrier>("http://takibi.test", { listAll: { pageSize: 0 } }),
  ).toThrow(TypeError);
  expect(() =>
    createClient<PostsCarrier>("http://takibi.test", {
      listAll: { pageSize: LIST_PAGE_MAX + 1 },
    }),
  ).toThrow(TypeError);
  expect(() =>
    createClient<PostsCarrier>("http://takibi.test", { listAll: { maxItems: 0 } }),
  ).toThrow(TypeError);
});

test("listAll call-site caps cannot exceed createClient caps", () => {
  const client = createClient<PostsCarrier>("http://takibi.test", {
    listAll: { maxItems: 5, pageSize: 10 },
    fetch: () => Response.json({ ok: true, data: { items: [] } }),
  });
  expect(() => client.posts.listAll({ maxItems: 6 })).toThrow(TypeError);
  expect(() => client.posts.listAll({ pageSize: 11 })).toThrow(TypeError);
  expect(() => client.posts.listAll({ pageSize: LIST_ALL_PAGE_SIZE_DEFAULT })).toThrow(TypeError);
});

test("listAll walks cursors, compiles where, and stops at the last page", async () => {
  const urls: string[] = [];
  const client = createClient<PostsCarrier>("http://takibi.test", {
    listAll: { pageSize: 2, maxItems: 10 },
    fetch: (input) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      const cursor = new URL(url).searchParams.get("cursor");
      if (cursor === "c1") {
        return Response.json({
          ok: true,
          data: { items: [{ id: "p3", title: "c" }] },
        });
      }
      return Response.json({
        ok: true,
        data: {
          items: [
            { id: "p1", title: "a" },
            { id: "p2", title: "b" },
          ],
          nextCursor: "c1",
        },
      });
    },
  });

  const listed = await client.posts.listAll({
    pageSize: 2,
    where: (query) => query.title.eq("keep"),
  });
  expect(listed).toEqual({
    ok: true,
    data: [
      { id: "p1", title: "a" },
      { id: "p2", title: "b" },
      { id: "p3", title: "c" },
    ],
  });
  expect(urls).toHaveLength(2);
  expect(new URL(urls[0]!).searchParams.get("limit")).toBe("2");
  expect(new URL(urls[0]!).searchParams.get("cursor")).toBeNull();
  expect(JSON.parse(new URL(urls[0]!).searchParams.get("where")!)).toEqual({
    field: "title",
    op: "eq",
    value: "keep",
  });
  expect(new URL(urls[1]!).searchParams.get("cursor")).toBe("c1");
  expect(JSON.parse(new URL(urls[1]!).searchParams.get("where")!)).toEqual({
    field: "title",
    op: "eq",
    value: "keep",
  });
});

test("listAll fails with LIST_ALL_LIMIT when matching documents remain", async () => {
  const client = createClient<PostsCarrier>("http://takibi.test", {
    listAll: { maxItems: 3, pageSize: 2 },
    fetch: () =>
      Response.json({
        ok: true,
        data: {
          items: [
            { id: "p1", title: "a" },
            { id: "p2", title: "b" },
          ],
          nextCursor: "more",
        },
      }),
  });

  await expect(client.posts.listAll()).resolves.toMatchObject({
    ok: false,
    error: {
      kind: "operation",
      code: "LIST_ALL_LIMIT",
      status: 400,
    },
  });
});
