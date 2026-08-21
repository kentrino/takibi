import { BadRequestError, TakibiError, NotFoundError } from "./errors";
import type { ActionInvocation } from "./action-executor";
import type { ExecuteRequest } from "./executor";
import { normalizeQueryExpr } from "./query";
import type { StorageListOptions } from "./types";

export class MethodNotAllowedError extends TakibiError {
  constructor(message = "Method not allowed") {
    super("METHOD_NOT_ALLOWED", message, 405);
    this.name = "MethodNotAllowedError";
  }
}

export function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Prefix is a path-segment boundary: `/api/takibi` matches `/api/takibi/posts`
 * and `/api/takibi/posts/{id}`, but not `/api/takibihose`.
 */
export function matchesPublicPrefix(pathname: string, prefix: string | undefined): boolean {
  if (prefix == null || prefix === "") return true;
  const path = normalizePathname(pathname);
  const pre = normalizePathname(prefix);
  if (pre === "/") return true;
  return path === pre || path.startsWith(`${pre}/`);
}

export function publicPathRemainder(pathname: string, prefix: string | undefined): string {
  const path = normalizePathname(pathname);
  if (prefix == null || prefix === "") return path;
  const pre = normalizePathname(prefix);
  if (pre === "/") return path;
  if (path === pre) return "/";
  return path.slice(pre.length);
}

/**
 * Trailing raw (still percent-encoded) segments of a matched route. Used by
 * the Hono mounts, whose params are decoded too early for raw colon routing.
 */
export function rawPathSegments(pathname: string, count: number): string[] {
  const path = normalizePathname(pathname);
  const segments = path === "/" ? [] : path.slice(1).split("/");
  return segments.slice(Math.max(0, segments.length - count));
}

export type PublicRequest = ExecuteRequest | ActionInvocation;

export async function decodePublicHttp(request: Request, prefix?: string): Promise<PublicRequest> {
  const url = new URL(request.url);
  const rest = publicPathRemainder(url.pathname, prefix);
  const rawSegments = rest === "/" ? [] : rest.slice(1).split("/");
  return decodePublicRoute(request.method, rawSegments, url.searchParams, () =>
    readRequestJson(request),
  );
}

/** Empty POST bodies are omitted input; invalid JSON is a bad request. */
export async function readRequestJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError("Expected JSON body");
  }
}

function decodeSegmentPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new BadRequestError("Malformed path encoding");
  }
}

/**
 * Decode a public route from raw (still percent-encoded) path segments.
 * Colon routing happens on the raw text so encoded `%3A` inside ids never
 * collides with the `:`-separated action syntax.
 */
export async function decodePublicRoute(
  method: string,
  rawSegments: string[],
  searchParams: URLSearchParams,
  readBody: () => Promise<unknown>,
): Promise<PublicRequest> {
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment === "")) {
    throw new BadRequestError("Missing collection");
  }
  if (rawSegments.length > 2) {
    throw new NotFoundError();
  }

  const rawCollection = rawSegments[0]!;
  const separator = rawCollection.indexOf(":");
  if (separator >= 0) {
    if (rawSegments.length !== 1) throw new NotFoundError();
    const scope = decodeSegmentPart(rawCollection.slice(0, separator));
    const name = decodeSegmentPart(rawCollection.slice(separator + 1));
    if (!scope || !name || name.includes(":")) {
      throw new BadRequestError("Invalid action path");
    }
    if (method !== "POST") throw new MethodNotAllowedError();
    assertNoQuery(searchParams, "Query parameters are not allowed on actions");
    const input = await readOptionalJsonBody(readBody);
    return {
      kind: "action",
      scope,
      name,
      ...(input.present ? { input: input.value } : {}),
    };
  }

  const collection = decodeSegmentPart(rawCollection);
  const rawId = rawSegments[1];

  if (rawId !== undefined && rawId.includes(":")) {
    // Document action route: split on the raw last colon, then decode. The
    // client encodes ids with encodeURIComponent, so a raw `:` always marks
    // the action name boundary.
    const boundary = rawId.lastIndexOf(":");
    const id = decodeSegmentPart(rawId.slice(0, boundary));
    const name = decodeSegmentPart(rawId.slice(boundary + 1));
    if (!id || !name) {
      throw new BadRequestError("Invalid action path");
    }
    if (method !== "POST") throw new MethodNotAllowedError();
    assertNoQuery(searchParams, "Query parameters are not allowed on actions");
    const input = await readOptionalJsonBody(readBody);
    return {
      kind: "action",
      scope: collection,
      name,
      id,
      ...(input.present ? { input: input.value } : {}),
    };
  }

  const id = rawId === undefined ? undefined : decodeSegmentPart(rawId);

  if (id === undefined) {
    if (method === "POST") {
      assertNoQuery(searchParams);
      return {
        kind: "collection",
        collection,
        operation: "add",
        input: await readJsonBody(readBody),
      };
    }
    if (method === "GET") {
      return {
        kind: "collection",
        collection,
        operation: "list",
        list: parseListQuery(searchParams),
      };
    }
    throw new MethodNotAllowedError();
  }

  if (method === "GET") {
    assertNoQuery(searchParams);
    return { kind: "collection", collection, operation: "get", id };
  }
  if (method === "PUT") {
    assertNoQuery(searchParams);
    return {
      kind: "collection",
      collection,
      operation: "set",
      id,
      input: await readJsonBody(readBody),
    };
  }
  if (method === "PATCH") {
    assertNoQuery(searchParams);
    return {
      kind: "collection",
      collection,
      operation: "update",
      id,
      input: await readJsonBody(readBody),
    };
  }
  if (method === "DELETE") {
    assertNoQuery(searchParams);
    return { kind: "collection", collection, operation: "delete", id };
  }
  if (method === "POST") {
    assertNoQuery(searchParams);
    return {
      kind: "collection",
      collection,
      operation: "add",
      id,
      input: await readJsonBody(readBody),
    };
  }
  throw new MethodNotAllowedError();
}

function assertNoQuery(
  searchParams: URLSearchParams,
  message = "Query parameters are only allowed on list",
): void {
  if ([...searchParams.keys()].length > 0) {
    throw new BadRequestError(message);
  }
}

function parseListQuery(searchParams: URLSearchParams): StorageListOptions | undefined {
  for (const key of searchParams.keys()) {
    if (key !== "limit" && key !== "cursor" && key !== "where") {
      throw new BadRequestError(`Unknown query parameter: ${key}`);
    }
  }
  const list: StorageListOptions = {};
  if (searchParams.has("limit")) {
    const raw = searchParams.get("limit") ?? "";
    if (!/^[0-9]+$/.test(raw)) {
      throw new BadRequestError("Invalid limit");
    }
    list.limit = Number(raw);
  }
  if (searchParams.has("cursor")) {
    list.cursor = searchParams.get("cursor") ?? "";
  }
  if (searchParams.has("where")) {
    try {
      list.where = normalizeQueryExpr(JSON.parse(searchParams.get("where") ?? ""));
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : "Invalid where query");
    }
  }
  return Object.keys(list).length > 0 ? list : undefined;
}

async function readJsonBody(readBody: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await readBody();
    if (value === undefined) throw new Error("Missing body");
    return value;
  } catch {
    throw new BadRequestError("Expected JSON body");
  }
}

async function readOptionalJsonBody(
  readBody: () => Promise<unknown>,
): Promise<{ present: false } | { present: true; value: unknown }> {
  try {
    const value = await readBody();
    return value === undefined ? { present: false } : { present: true, value };
  } catch {
    throw new BadRequestError("Expected JSON body");
  }
}
