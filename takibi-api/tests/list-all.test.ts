import { expect, test } from "vite-plus/test";
import {
  LIST_ALL_PAGE_SIZE_DEFAULT,
  LIST_PAGE_MAX,
  assertListAllConfig,
  collectListPages,
  collectListPagesResult,
  listAllLimitFailure,
  resolveListAllBounds,
} from "../src";

test("listAll bounds reject non-positive page sizes and clamp to the caller cap", () => {
  expect(LIST_ALL_PAGE_SIZE_DEFAULT).toBe(LIST_PAGE_MAX);
  expect(() => assertListAllConfig({ pageSize: 0 })).toThrow(/integer >= 1/);
  expect(() => assertListAllConfig({ pageSize: LIST_PAGE_MAX + 1 })).toThrow(/must not exceed/);
  expect(resolveListAllBounds({ pageSize: 10 }, { pageSize: 20, maxItems: 50 })).toEqual({
    pageSize: 10,
    maxItems: 50,
  });
  expect(() => resolveListAllBounds({ pageSize: 30 }, { pageSize: 20 })).toThrow(/must not exceed/);
});

test("collectListPages follows cursors and throws LIST_ALL_LIMIT", async () => {
  const pages = [
    { items: ["a", "b"], nextCursor: "2" },
    { items: ["c"], nextCursor: undefined },
  ];
  let calls = 0;
  const items = await collectListPages(
    async () => {
      const page = pages[calls];
      calls += 1;
      return page ?? { items: [] };
    },
    { pageSize: 2 },
  );
  expect(items).toEqual(["a", "b", "c"]);
  expect(calls).toBe(2);

  await expect(
    collectListPages(
      async (cursor) => {
        if (cursor === undefined) return { items: ["a", "b"], nextCursor: "2" };
        return { items: ["c", "d"], nextCursor: "3" };
      },
      { pageSize: 2, maxItems: 3 },
    ),
  ).rejects.toMatchObject({ code: "LIST_ALL_LIMIT", status: 400 });
});

test("collectListPagesResult returns a LIST_ALL_LIMIT operation failure", async () => {
  const result = await collectListPagesResult(
    async (cursor) => {
      if (cursor === undefined)
        return { ok: true as const, data: { items: ["a", "b"], nextCursor: "2" } };
      return { ok: true as const, data: { items: ["c", "d"] } };
    },
    { pageSize: 2, maxItems: 3 },
  );
  expect(result).toEqual({ ok: false, error: listAllLimitFailure(3) });
});
