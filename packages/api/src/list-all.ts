import type { ListOptions } from "@takibi/query";
import type { TakibiFailure, TakibiOperationFailure, TakibiResult } from "@takibi/shared-types";
import { ListAllLimitError } from "./errors";
import type { ListAllOptions } from "./types";

/** Default `list` page size when the caller omits `limit`. */
export const LIST_PAGE_DEFAULT = 50;
/** Hard per-request `list` cap. Larger `limit` / `pageSize` values are rejected or clamped here. */
export const LIST_PAGE_MAX = 200;
/** Default `listAll` page size: the per-`list` maximum. */
export const LIST_ALL_PAGE_SIZE_DEFAULT = LIST_PAGE_MAX;
/** Default public-client `listAll` safety cap. Call-site values may only be smaller. */
export const LIST_ALL_MAX_ITEMS_DEFAULT = 10_000;

export type ListAllBounds = {
  pageSize: number;
  maxItems?: number;
};

type ListPage<T> = { items: T[]; nextCursor?: string };

export function listAllLimitFailure(maxItems: number): TakibiOperationFailure {
  return {
    kind: "operation",
    code: "LIST_ALL_LIMIT",
    message: `listAll exceeded the maximum of ${maxItems} documents`,
    status: 400,
  };
}

export function assertListAllConfig(value: ListAllBounds | undefined): void {
  if (value === undefined) return;
  assertPositiveInt("listAll.pageSize", value.pageSize, LIST_PAGE_MAX);
  if (value.maxItems !== undefined) {
    assertPositiveInt("listAll.maxItems", value.maxItems);
  }
}

export function resolveListAllBounds(
  call: { pageSize?: number; maxItems?: number } | undefined,
  cap: ListAllBounds,
): ListAllBounds {
  const pageSize = call?.pageSize ?? cap.pageSize;
  const maxItems = call?.maxItems ?? cap.maxItems;
  assertPositiveInt("listAll pageSize", pageSize, cap.pageSize);
  if (maxItems !== undefined) {
    assertPositiveInt("listAll maxItems", maxItems, cap.maxItems);
  }
  return { pageSize, ...(maxItems === undefined ? {} : { maxItems }) };
}

function assertPositiveInt(name: string, value: number, max?: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be an integer >= 1`);
  }
  if (max !== undefined && value > max) {
    throw new TypeError(`${name} must not exceed ${max}`);
  }
}

function pageOptions<TDoc, TIndexes extends Record<string, readonly string[]>>(
  options: ListAllOptions<TDoc, TIndexes> | undefined,
  cursor: string | undefined,
  limit: number,
): ListOptions<TDoc, TIndexes> {
  const index = options && "index" in options ? options.index : undefined;
  const orderBy = options && "orderBy" in options ? options.orderBy : undefined;
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(options?.where === undefined ? {} : { where: options.where }),
    ...(typeof index === "string" ? { index } : {}),
    ...(orderBy === undefined ? {} : { orderBy }),
  } as ListOptions<TDoc, TIndexes>;
}

export async function collectListPages<T>(
  loadPage: (cursor: string | undefined, limit: number) => Promise<ListPage<T>>,
  bounds: ListAllBounds,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const limit = nextPageLimit(items.length, bounds);
    if (limit === undefined) {
      if (bounds.maxItems === undefined) {
        throw new TypeError("listAll page size resolved to empty");
      }
      throw new ListAllLimitError(bounds.maxItems);
    }
    const page = await loadPage(cursor, limit);
    items.push(...page.items);
    if (bounds.maxItems !== undefined && items.length > bounds.maxItems) {
      throw new ListAllLimitError(bounds.maxItems);
    }
    if (page.nextCursor === undefined) return items;
    if (bounds.maxItems !== undefined && items.length >= bounds.maxItems) {
      throw new ListAllLimitError(bounds.maxItems);
    }
    cursor = page.nextCursor;
  }
}

export async function collectListPagesResult<T, TReasonCode extends string = never>(
  loadPage: (
    cursor: string | undefined,
    limit: number,
  ) => Promise<TakibiResult<ListPage<T>, TReasonCode>>,
  bounds: { pageSize: number; maxItems: number },
): Promise<TakibiResult<T[], TReasonCode>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const limit = nextPageLimit(items.length, bounds);
    if (limit === undefined) {
      return {
        ok: false,
        error: listAllLimitFailure(bounds.maxItems) as TakibiFailure<TReasonCode>,
      };
    }
    const page = await loadPage(cursor, limit);
    if (!page.ok) return page;
    items.push(...page.data.items);
    if (items.length > bounds.maxItems) {
      return {
        ok: false,
        error: listAllLimitFailure(bounds.maxItems) as TakibiFailure<TReasonCode>,
      };
    }
    if (page.data.nextCursor === undefined) return { ok: true, data: items };
    if (items.length >= bounds.maxItems) {
      return {
        ok: false,
        error: listAllLimitFailure(bounds.maxItems) as TakibiFailure<TReasonCode>,
      };
    }
    cursor = page.data.nextCursor;
  }
}

function nextPageLimit(itemCount: number, bounds: ListAllBounds): number | undefined {
  if (bounds.maxItems === undefined) return bounds.pageSize;
  const remaining = bounds.maxItems - itemCount;
  if (remaining <= 0) return undefined;
  return Math.min(bounds.pageSize, remaining);
}

export function bindThrowingListAll<
  TDoc,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
>(
  list: (opts?: ListOptions<TDoc, TIndexes>) => Promise<ListPage<TDoc>>,
  cap: ListAllBounds = { pageSize: LIST_ALL_PAGE_SIZE_DEFAULT },
): (opts?: ListAllOptions<TDoc, TIndexes>) => Promise<TDoc[]> {
  return (options) => {
    const bounds = resolveListAllBounds(options, cap);
    return collectListPages((cursor, limit) => list(pageOptions(options, cursor, limit)), bounds);
  };
}

export function bindResultListAll<
  TDoc,
  TReasonCode extends string = never,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
>(
  list: (opts?: ListOptions<TDoc, TIndexes>) => Promise<TakibiResult<ListPage<TDoc>, TReasonCode>>,
  cap: { pageSize: number; maxItems: number },
): (opts?: ListAllOptions<TDoc, TIndexes>) => Promise<TakibiResult<TDoc[], TReasonCode>> {
  return (options) => {
    const bounds = resolveListAllBounds(options, cap);
    return collectListPagesResult((cursor, limit) => list(pageOptions(options, cursor, limit)), {
      pageSize: bounds.pageSize,
      maxItems: bounds.maxItems ?? cap.maxItems,
    });
  };
}
