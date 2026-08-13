import type { FireHandler } from "./context";
import { isWireResponse, type WireResponse } from "./protocol";
import type { ClientOf, CollectionApi, FireResult, ResourceOperation } from "./types";

export type InferHandlerResources<H> = H extends {
  readonly "~fire": { resources: infer R };
}
  ? R
  : H extends FireHandler<infer _C, infer R>
    ? R
    : never;

export type CreateClientOptions = {
  /** Static headers or a getter (e.g. attach tenant / auth tokens). */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
};

export function createClient<H>(
  baseUrl: string,
  options: CreateClientOptions = {},
): ClientOf<InferHandlerResources<H>> {
  const resources = new Proxy(
    {},
    {
      get(_target, resource: string | symbol) {
        if (typeof resource !== "string") return undefined;
        return createCollectionClient(baseUrl, resource, options);
      },
    },
  );
  return resources as ClientOf<InferHandlerResources<H>>;
}

function createCollectionClient(
  baseUrl: string,
  resource: string,
  options: CreateClientOptions,
): CollectionApi<{ schema: never }> {
  const call = async <T>(
    operation: ResourceOperation,
    parts: { id?: string; input?: unknown; list?: { limit?: number; cursor?: string } } = {},
  ): Promise<FireResult<T>> => {
    if (parts.id === "") {
      return {
        ok: false,
        error: {
          kind: "validation",
          code: "VALIDATION",
          message: "id must be a non-empty string",
          status: 400,
          issues: [{ message: "id must be a non-empty string", path: ["id"] }],
        },
      };
    }

    const headers = new Headers(
      typeof options.headers === "function" ? await options.headers() : (options.headers ?? {}),
    );
    const { method, url, body } = buildPublicRequest(baseUrl, resource, operation, parts);
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw err instanceof Error ? err : new Error("Failed to decode response JSON");
    }

    if (!isWireResponse(json)) {
      throw new Error("Invalid response envelope");
    }

    const wire = json as WireResponse;
    if (!wire.ok) {
      return { ok: false, error: wire.error };
    }
    return { ok: true, data: wire.data as T };
  };

  return {
    add: (data, options) => call("add", { id: options?.id, input: data }),
    set: (id, data) => call("set", { id, input: data }),
    get: (id) => call("get", { id }),
    update: (id, data) => call("update", { id, input: data }),
    delete: (id) => call("delete", { id }),
    list: (opts) => call("list", { list: opts }),
  };
}

function buildPublicRequest(
  baseUrl: string,
  resource: string,
  operation: ResourceOperation,
  parts: { id?: string; input?: unknown; list?: { limit?: number; cursor?: string } },
): { method: string; url: string; body?: string } {
  const prefix = baseUrl.replace(/\/$/, "");
  const collection = `${prefix}/${encodeURIComponent(resource)}`;
  const item =
    parts.id !== undefined ? `${collection}/${encodeURIComponent(parts.id)}` : collection;

  switch (operation) {
    case "add":
      return { method: "POST", url: item, body: JSON.stringify(parts.input) };
    case "set":
      return { method: "PUT", url: item, body: JSON.stringify(parts.input) };
    case "get":
      return { method: "GET", url: item };
    case "update":
      return { method: "PATCH", url: item, body: JSON.stringify(parts.input) };
    case "delete":
      return { method: "DELETE", url: item };
    case "list": {
      const params = new URLSearchParams();
      if (parts.list?.limit !== undefined) params.set("limit", String(parts.list.limit));
      if (parts.list?.cursor !== undefined) params.set("cursor", parts.list.cursor);
      const query = params.toString();
      return { method: "GET", url: query ? `${collection}?${query}` : collection };
    }
    default: {
      const _exhaustive: never = operation;
      return _exhaustive;
    }
  }
}
