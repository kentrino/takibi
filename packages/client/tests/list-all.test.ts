import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { LIST_PAGE_MAX } from "@takibi/api";
import { createClient } from "@takibi/client";

const Post = z.object({ title: z.string() });

type PostsCarrier = {
  readonly "~takibi": {
    readonly collections: {
      readonly posts: { readonly schema: typeof Post };
    };
  };
};

test.each([
  { name: "zero page size", caps: { pageSize: 0 } },
  { name: "page size above the server maximum", caps: { pageSize: LIST_PAGE_MAX + 1 } },
  { name: "zero item limit", caps: { maxItems: 0 } },
])("createClient rejects $name", ({ caps }) => {
  expect(() => createClient<PostsCarrier>("http://takibi.test", { listAll: caps })).toThrow(
    TypeError,
  );
});

test.each([
  { name: "item limit", caps: { maxItems: 6 } },
  { name: "page size", caps: { pageSize: 11 } },
])("listAll rejects a call-site $name above the client cap", ({ caps }) => {
  const fetch = vi.fn(() => Response.json({ ok: true, data: { items: [] } }));
  const client = createClient<PostsCarrier>("http://takibi.test", {
    listAll: { maxItems: 5, pageSize: 10 },
    fetch,
  });

  expect(() => client.posts.listAll(caps)).toThrow(TypeError);
  expect(fetch).not.toHaveBeenCalled();
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

test.each([
  {
    name: "returns every item when the final page reaches the cap",
    finalPage: { items: [{ id: "p3", title: "c" }] },
    expected: {
      ok: true,
      data: [
        { id: "p1", title: "a" },
        { id: "p2", title: "b" },
        { id: "p3", title: "c" },
      ],
    },
  },
  {
    name: "fails instead of truncating when another page remains at the cap",
    finalPage: { items: [{ id: "p3", title: "c" }], nextCursor: "more" },
    expected: {
      ok: false,
      error: {
        kind: "operation",
        code: "LIST_ALL_LIMIT",
        message: "listAll exceeded the maximum of 3 documents",
        status: 400,
      },
    },
  },
  {
    name: "fails when the server returns more items than the remaining allowance",
    finalPage: {
      items: [
        { id: "p3", title: "c" },
        { id: "p4", title: "d" },
      ],
    },
    expected: {
      ok: false,
      error: {
        kind: "operation",
        code: "LIST_ALL_LIMIT",
        message: "listAll exceeded the maximum of 3 documents",
        status: 400,
      },
    },
  },
])("listAll $name", async ({ finalPage, expected }) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        data: {
          items: [
            { id: "p1", title: "a" },
            { id: "p2", title: "b" },
          ],
          nextCursor: "c1",
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true, data: finalPage }));
  const client = createClient<PostsCarrier>("http://takibi.test", {
    listAll: { maxItems: 3, pageSize: 2 },
    fetch,
  });

  const result = await client.posts.listAll();

  expect(result).toEqual(expected);
  expect(fetch).toHaveBeenCalledTimes(2);
  const requests = fetch.mock.calls.map(
    ([input]) => new URL(input instanceof Request ? input.url : String(input)),
  );
  expect(
    requests.map((url) => ({
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
    })),
  ).toEqual([
    { limit: "2", cursor: null },
    { limit: "1", cursor: "c1" },
  ]);
});
