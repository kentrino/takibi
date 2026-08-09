import type { FireHandler } from "./context";
import { FireError } from "./errors";
import type { WireRequest, WireResponse } from "./protocol";
import type { ClientOf, CollectionApi, ResourceOperation } from "./types";

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
  const call = async (
    operation: ResourceOperation,
    parts: { id?: string; input?: unknown; list?: { limit?: number; cursor?: string } } = {},
  ) => {
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

    const json = (await res.json()) as WireResponse;
    if (!json.ok) {
      throw new FireError(json.error.code, json.error.message, json.error.status);
    }
    return json.data;
  };

  return {
    add: (data) => call("add", { input: data }) as never,
    set: (id, data) => call("set", { id, input: data }) as never,
    get: (id) => call("get", { id }) as never,
    update: (id, data) => call("update", { id, input: data }) as never,
    delete: (id) => call("delete", { id }) as never,
    list: (opts) => call("list", { list: opts }) as never,
  };
}
