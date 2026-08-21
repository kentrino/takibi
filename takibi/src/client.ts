import type { StandardSchemaV1 } from "@standard-schema/spec";
import { unsafeClientPropertyNames } from "./action";
import type { TakibiHandler } from "./context-types";
import { isWireResponse, type WireResponse } from "./protocol";
import { compileListOptions } from "./query";
import type {
  ClientCollectionApi,
  CollectionOperation,
  PolicyReasonCodeOf,
  TakibiResult,
  StorageListOptions,
} from "./types";

export type InferHandlerCollections<H> = H extends {
  readonly "~takibi": { collections: infer C };
}
  ? C
  : H extends TakibiHandler<infer _C, infer C>
    ? C
    : never;

/** Scope map registered via `app.actions({ ... })` (`$` plus collection keys). */
export type InferHandlerActions<H> = H extends {
  readonly "~takibi": { actions: infer A };
}
  ? A
  : Record<never, never>;

type ScopeActionsOf<TMap, K extends string> = K extends keyof TMap ? TMap[K] : Record<never, never>;

type ActionSchema<TAction> = TAction extends {
  readonly inputSchema: infer TSchema;
}
  ? TSchema
  : never;

type ActionInput<TAction> =
  ActionSchema<TAction> extends infer TSchema
    ? TSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<TSchema>
      : never
    : never;

type NormalizeActionOutput<T> = T extends void ? null : T;

type ActionOutput<TAction> = TAction extends {
  readonly handler: (...args: infer _TArgs) => infer TResult;
}
  ? NormalizeActionOutput<Awaited<TResult>>
  : never;

type ActionReasonCode<TAction> = TAction extends { readonly policy: infer TPolicy }
  ? PolicyReasonCodeOf<TPolicy>
  : never;

type DetachedActionClientMethod<TAction> = TAction extends {
  readonly inputSchema: infer TSchema;
}
  ? TSchema extends StandardSchemaV1
    ? undefined extends ActionInput<TAction>
      ? (
          input?: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
      : (
          input: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
    : () => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
  : never;

type DocumentActionClientMethod<TAction> = TAction extends {
  readonly inputSchema: infer TSchema;
}
  ? TSchema extends StandardSchemaV1
    ? undefined extends ActionInput<TAction>
      ? (
          id: string,
          input?: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
      : (
          id: string,
          input: ActionInput<TAction>,
        ) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
    : (id: string) => Promise<TakibiResult<ActionOutput<TAction>, ActionReasonCode<TAction>>>
  : never;

type ActionClientMethod<TAction> = TAction extends { readonly target: "document" }
  ? DocumentActionClientMethod<TAction>
  : DetachedActionClientMethod<TAction>;

type ActionsClient<TActions> = {
  [K in keyof TActions as K extends string ? K : never]: ActionClientMethod<TActions[K]>;
};

type TakibiHandlerCarrier = {
  readonly "~takibi": { collections: unknown };
};

type ClientFromMaps<TCollections, TActionMap = Record<never, never>> = {
  [K in keyof TCollections]: ClientCollectionApi<TCollections[K]> &
    (K extends string ? ActionsClient<ScopeActionsOf<TActionMap, K>> : Record<never, never>);
} & ActionsClient<ScopeActionsOf<TActionMap, "$">>;

export type ClientOf<H extends TakibiHandlerCarrier> = H extends infer Concrete
  ? ClientFromMaps<InferHandlerCollections<Concrete>, InferHandlerActions<Concrete>>
  : never;

export type CreateClientOptions = {
  /** Static headers or a getter (e.g. attach tenant / auth tokens). */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
};

export function createClient<H extends TakibiHandlerCarrier>(
  baseUrl: string,
  options: CreateClientOptions = {},
): ClientOf<H> {
  const members = new Map<string, unknown>();
  const client = new Proxy(Object.create(null) as object, {
    get(_target, name: string | symbol) {
      if (typeof name !== "string" || unsafeClientPropertyNames.has(name)) return undefined;
      let member = members.get(name);
      if (!member) {
        member = createRootMember(baseUrl, name, options);
        members.set(name, member);
      }
      return member;
    },
  });
  return client as ClientOf<H>;
}

function createRootMember(baseUrl: string, name: string, options: CreateClientOptions): unknown {
  const collection = createCollectionClient(baseUrl, name, options);
  const rootAction = (...args: unknown[]) =>
    callEndpoint<unknown>(baseUrl, options, {
      method: "POST",
      path: `$:${name}`,
      ...(args.length > 0 && args[0] !== undefined ? { input: args[0] } : {}),
    });
  return new Proxy(rootAction, {
    get(_target, property: string | symbol) {
      if (typeof property !== "string" || unsafeClientPropertyNames.has(property)) return undefined;
      return Reflect.get(collection, property);
    },
  });
}

function createCollectionClient(
  baseUrl: string,
  collection: string,
  options: CreateClientOptions,
): ClientCollectionApi<{ schema: never }> {
  const call = async <T>(
    operation: CollectionOperation,
    parts: { id?: string; input?: unknown; list?: StorageListOptions } = {},
  ): Promise<TakibiResult<T>> => {
    if (parts.id === "") {
      return Promise.resolve(emptyIdFailure());
    }

    const request = buildPublicRequest(collection, operation, parts);
    return callEndpoint<T>(baseUrl, options, request);
  };

  const crud: ClientCollectionApi<{ schema: never }> = {
    add: (data, options) => call("add", { id: options?.id, input: data }),
    set: (id, data) => call("set", { id, input: data }),
    get: (id) => call("get", { id }),
    update: (id, data) => call("update", { id, input: data }),
    delete: (id) => call("delete", { id }),
    list: (opts) => call("list", { list: compileListOptions(opts) }),
  };
  const actions = new Map<string, unknown>();
  return new Proxy(crud, {
    get(target, name: string | symbol) {
      if (typeof name !== "string" || unsafeClientPropertyNames.has(name)) return undefined;
      if (Object.prototype.hasOwnProperty.call(target, name)) {
        return Reflect.get(target, name);
      }
      let action = actions.get(name);
      if (!action) {
        // Document actions are called as `(id, input?)`. A lone string
        // argument is always a document id — detached collection actions
        // cannot accept bare-string input (enforced at definition time), so
        // the two call shapes never collide at runtime.
        action = (...args: unknown[]) => {
          const documentCall = args.length >= 2 || typeof args[0] === "string";
          if (documentCall) {
            const id = args[0];
            if (typeof id !== "string" || id === "") {
              return Promise.resolve(emptyIdFailure());
            }
            return callEndpoint<unknown>(baseUrl, options, {
              method: "POST",
              path: `${encodeURIComponent(collection)}/${encodeURIComponent(id)}:${name}`,
              ...(args.length > 1 && args[1] !== undefined ? { input: args[1] } : {}),
            });
          }
          return callEndpoint<unknown>(baseUrl, options, {
            method: "POST",
            path: `${collection}:${name}`,
            ...(args.length > 0 && args[0] !== undefined ? { input: args[0] } : {}),
          });
        };
        actions.set(name, action);
      }
      return action;
    },
  }) as ClientCollectionApi<{ schema: never }>;
}

function emptyIdFailure(): TakibiResult<never> {
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

function buildPublicRequest(
  collection: string,
  operation: CollectionOperation,
  parts: { id?: string; input?: unknown; list?: StorageListOptions },
): { method: string; path: string; input?: unknown; query?: URLSearchParams } {
  const encodedCollection = encodeURIComponent(collection);
  const item =
    parts.id !== undefined
      ? `${encodedCollection}/${encodeURIComponent(parts.id)}`
      : encodedCollection;

  switch (operation) {
    case "add":
      return { method: "POST", path: item, input: parts.input };
    case "set":
      return { method: "PUT", path: item, input: parts.input };
    case "get":
      return { method: "GET", path: item };
    case "update":
      return { method: "PATCH", path: item, input: parts.input };
    case "delete":
      return { method: "DELETE", path: item };
    case "list": {
      const params = new URLSearchParams();
      if (parts.list?.limit !== undefined) params.set("limit", String(parts.list.limit));
      if (parts.list?.cursor !== undefined) params.set("cursor", parts.list.cursor);
      if (parts.list?.where !== undefined) params.set("where", JSON.stringify(parts.list.where));
      return { method: "GET", path: encodedCollection, query: params };
    }
    default: {
      const _exhaustive: never = operation;
      return _exhaustive;
    }
  }
}

async function callEndpoint<T>(
  baseUrl: string,
  options: CreateClientOptions,
  request: {
    method: string;
    path: string;
    input?: unknown;
    query?: URLSearchParams;
  },
): Promise<TakibiResult<T>> {
  const headers = new Headers(
    typeof options.headers === "function" ? await options.headers() : (options.headers ?? {}),
  );
  const prefix = baseUrl.replace(/\/$/, "");
  const query = request.query?.toString();
  const url = `${prefix}/${request.path}${query ? `?${query}` : ""}`;
  const hasInput = Object.prototype.hasOwnProperty.call(request, "input");
  const body = hasInput ? encodeJsonInput(request.input) : undefined;
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw error instanceof Error ? error : new Error("Failed to decode response JSON");
  }
  if (!isWireResponse(json)) throw new Error("Invalid response envelope");
  const wire = json as WireResponse;
  return wire.ok ? { ok: true, data: wire.data as T } : { ok: false, error: wire.error };
}

function encodeJsonInput(input: unknown): string {
  assertJsonInput(input);
  return JSON.stringify(input);
}

function assertJsonInput(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("Action input must be JSON-safe");
  }
  if (seen.has(value)) throw new TypeError("Action input must not be cyclic");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Action input arrays must not be sparse");
      }
      assertJsonInput(descriptor.value, seen);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw new TypeError("Action input arrays must not have custom properties");
      }
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Action input must contain only plain JSON objects");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("Action input must not contain symbols");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Action input must contain only enumerable data properties");
    }
    assertJsonInput(descriptor.value, seen);
  }
  seen.delete(value);
}
