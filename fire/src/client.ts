import type { FireHandler } from "./context";
import { isWireResponse, type WireRequest, type WireResponse } from "./protocol";
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
    const payload: Omit<WireRequest, "context"> = {
      resource,
      operation,
      ...parts,
    };

    const headers = new Headers(
      typeof options.headers === "function" ? await options.headers() : (options.headers ?? {}),
    );
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    const res = await fetchImpl(baseUrl.replace(/\/$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
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
