import { BadRequestError, FireError, NotFoundError } from "./errors";
import type { ExecuteRequest } from "./executor";

export class MethodNotAllowedError extends FireError {
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
 * Prefix is a path-segment boundary: `/api/fire` matches `/api/fire/posts`
 * and `/api/fire/posts/{id}`, but not `/api/firehose`.
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

export async function decodePublicHttp(request: Request, prefix?: string): Promise<ExecuteRequest> {
  const url = new URL(request.url);
  const rest = publicPathRemainder(url.pathname, prefix);
  const rawSegments = rest === "/" ? [] : rest.slice(1).split("/");
  let segments: string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw new BadRequestError("Malformed path encoding");
  }
  return decodePublicRoute(request.method, segments, url.searchParams, () => request.json());
}

export async function decodePublicRoute(
  method: string,
  segments: string[],
  searchParams: URLSearchParams,
  readBody: () => Promise<unknown>,
): Promise<ExecuteRequest> {
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    throw new BadRequestError("Missing resource");
  }
  if (segments.length > 2) {
    throw new NotFoundError();
  }

  const resource = segments[0]!;
  const id = segments[1];

  if (id === undefined) {
    if (method === "POST") {
      assertNoQuery(searchParams);
      return { resource, operation: "add", input: await readJsonBody(readBody) };
    }
    if (method === "GET") {
      return { resource, operation: "list", list: parseListQuery(searchParams) };
    }
    throw new MethodNotAllowedError();
  }

  if (method === "GET") {
    assertNoQuery(searchParams);
    return { resource, operation: "get", id };
  }
  if (method === "PUT") {
    assertNoQuery(searchParams);
    return { resource, operation: "set", id, input: await readJsonBody(readBody) };
  }
  if (method === "PATCH") {
    assertNoQuery(searchParams);
    return { resource, operation: "update", id, input: await readJsonBody(readBody) };
  }
  if (method === "DELETE") {
    assertNoQuery(searchParams);
    return { resource, operation: "delete", id };
  }
  if (method === "POST") {
    assertNoQuery(searchParams);
    return { resource, operation: "add", id, input: await readJsonBody(readBody) };
  }
  throw new MethodNotAllowedError();
}

function assertNoQuery(searchParams: URLSearchParams): void {
  if ([...searchParams.keys()].length > 0) {
    throw new BadRequestError("Query parameters are only allowed on list");
  }
}

function parseListQuery(
  searchParams: URLSearchParams,
): { limit?: number; cursor?: string } | undefined {
  for (const key of searchParams.keys()) {
    if (key !== "limit" && key !== "cursor") {
      throw new BadRequestError(`Unknown query parameter: ${key}`);
    }
  }
  const list: { limit?: number; cursor?: string } = {};
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
  return Object.keys(list).length > 0 ? list : undefined;
}

async function readJsonBody(readBody: () => Promise<unknown>): Promise<unknown> {
  try {
    return await readBody();
  } catch {
    throw new BadRequestError("Expected JSON body");
  }
}
