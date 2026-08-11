import { Hono } from "hono";
import { FireError, UnauthorizedError } from "./errors";
import { executeOperation } from "./executor";
import {
  decodeWireRequest,
  type WireFailure,
  type WireRequest,
  type WireResponse,
} from "./protocol";
import { toFireFailure } from "./result";
import { SchemaValidationError } from "./schema";
import { createDurableObjectStorage, createMemoryStorage } from "./storage";
import { createTypedStorage } from "./typed-storage";
import type { ClientOf, ResourceDefinition, ResourcesDef, StorageDriver } from "./types";

export type AuthBits = {
  tenantId: string;
  user: unknown;
  request: Request;
};

export type ContextConfig<TCtx extends { tenantId: string; user: unknown }> = {
  /** Extract tenant id (default: `x-tenant-id` header). */
  getTenantId?: (
    request: Request,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** Extract / verify user (default: parse `x-user` JSON header, else null). */
  getUser?: (request: Request) => Promise<unknown>;
  /**
   * Build the request context from tenant + user.
   * Must return at least `{ tenantId, user }`.
   */
  context?: (auth: AuthBits) => TCtx | Promise<TCtx>;
  /** Full-control resolver; when set, getTenantId / getUser / context are ignored. */
  resolve?: (input: { request: Request }) => TCtx | Promise<TCtx>;
};

export type ResourcesOptions = {
  /** Cloudflare DO binding name. Defaults to `TENANT_STORE`. */
  binding?: string;
  /** In-memory mode for tests / demos (skips Durable Object). */
  memory?: boolean;
};

export type FireBrand<TCtx extends { tenantId: string; user: unknown }, TResources> = {
  readonly "~fire": {
    context: TCtx;
    resources: TResources;
  };
  /**
   * Trusted server-side API: `storage.posts.add(...)`.
   * Bypasses ACL (like an admin SDK). Memory mode only on the worker;
   * inside the Durable Object use `this.storage`.
   */
  storage: ClientOf<TResources>;
  DurableObject: new (
    state: DurableObjectState,
    env: unknown,
  ) => DurableObject & { storage: ClientOf<TResources> };
};

export type FireHandler<
  TCtx extends { tenantId: string; user: unknown } = { tenantId: string; user: unknown },
  TResources = ResourcesDef<TCtx>,
> = Hono<{ Bindings: Record<string, unknown> }> & FireBrand<TCtx, TResources>;

type ContextBuilder<TCtx extends { tenantId: string; user: unknown }> =
  | ContextConfig<TCtx>
  | ((auth: AuthBits) => TCtx | Promise<TCtx>);

export function createContext<TCtx extends { tenantId: string; user: unknown }>(
  config: ContextBuilder<TCtx>,
) {
  const normalized: ContextConfig<TCtx> =
    typeof config === "function" ? { context: config } : config;

  const resolve = createResolver(normalized);

  return {
    resources<const TResources extends ResourcesDef<TCtx>>(
      resources: TResources,
      options: ResourcesOptions = {},
    ): FireHandler<TCtx, TResources> {
      const binding = options.binding ?? "TENANT_STORE";
      const memory = options.memory ?? false;

      const app = new Hono<{ Bindings: Record<string, unknown> }>();

      const memoryDriver = memory ? createMemoryStorage() : null;
      const storageApi = memoryDriver
        ? createTypedStorage(resources, memoryDriver)
        : createUnavailableStorage(resources);

      app.post("/", async (c) => {
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return c.json(
            {
              ok: false,
              error: {
                kind: "operation",
                code: "BAD_REQUEST",
                message: "Expected JSON body",
                status: 400,
              },
            } satisfies WireResponse,
            400,
          );
        }

        try {
          const ctx = await resolve({ request: c.req.raw });
          if (!ctx.tenantId) {
            throw new UnauthorizedError("Missing tenantId");
          }

          const op = decodeWireRequest({ ...(body as object), context: ctx });

          if (memoryDriver) {
            const data = await executeOperation(resources, memoryDriver, ctx, op);
            return c.json({ ok: true, data } satisfies WireResponse);
          }

          const ns = c.env[binding] as DurableObjectNamespace | undefined;
          if (!ns || typeof ns.idFromName !== "function") {
            throw new FireError(
              "MISSING_BINDING",
              `Durable Object binding "${binding}" not found on env`,
              500,
            );
          }

          const stub = ns.get(ns.idFromName(ctx.tenantId));
          const wire: WireRequest = { ...op, context: ctx };

          const res = await stub.fetch(
            new Request("https://fire.internal/", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(wire),
            }),
          );
          const json = (await res.json()) as WireResponse;
          return c.json(json, (json.ok ? 200 : json.error.status) as 200);
        } catch (err) {
          return c.json(toWireError(err), statusOf(err) as 400);
        }
      });

      const DurableObjectClass = createDurableObjectClass(resources);

      const handler = app as FireHandler<TCtx, TResources>;
      Object.defineProperty(handler, "~fire", {
        value: { context: null as unknown as TCtx, resources },
        enumerable: false,
      });
      handler.storage = storageApi;
      handler.DurableObject = DurableObjectClass as FireHandler<TCtx, TResources>["DurableObject"];
      return handler;
    },
  };
}

function createResolver<TCtx extends { tenantId: string; user: unknown }>(
  config: ContextConfig<TCtx>,
): (input: { request: Request }) => Promise<TCtx> {
  if (config.resolve) {
    return async (input) => config.resolve!(input);
  }

  const getTenantId =
    config.getTenantId ?? ((request: Request) => request.headers.get("x-tenant-id"));

  const getUser =
    config.getUser ??
    (async (request: Request) => {
      const raw = request.headers.get("x-user");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new UnauthorizedError("Invalid x-user header");
      }
    });

  const build =
    config.context ??
    ((auth: AuthBits) =>
      ({
        tenantId: auth.tenantId,
        user: auth.user,
      }) as TCtx);

  return async ({ request }) => {
    const tenantId = await getTenantId(request);
    if (!tenantId) {
      throw new UnauthorizedError("Missing tenant id (x-tenant-id)");
    }
    const user = await getUser(request);
    return build({ tenantId, user, request });
  };
}

function createDurableObjectClass<TResources extends Record<string, ResourceDefinition>>(
  resources: TResources,
) {
  return class FireTenantObject implements DurableObject {
    readonly #driver: StorageDriver;
    readonly storage: ClientOf<TResources>;

    constructor(state: DurableObjectState, _env: unknown) {
      this.#driver = createDurableObjectStorage(state.storage);
      this.storage = createTypedStorage(resources, this.#driver);
    }

    async fetch(request: Request): Promise<Response> {
      try {
        const body = decodeWireRequest(await request.json());
        const { context, ...op } = body;
        const data = await executeOperation(
          resources,
          this.#driver,
          context as { tenantId: string; user: unknown },
          op,
        );
        return Response.json({ ok: true, data } satisfies WireResponse);
      } catch (err) {
        const wire = toWireError(err);
        return Response.json(wire, { status: wire.error.status });
      }
    }
  };
}

function createUnavailableStorage<TResources extends Record<string, ResourceDefinition>>(
  resources: TResources,
): ClientOf<TResources> {
  const fail = async () =>
    ({
      ok: false as const,
      error: {
        kind: "operation" as const,
        code: "NO_STORAGE",
        message:
          "handler.storage is only available with `{ memory: true }`; in production use the Durable Object's `this.storage`",
        status: 500,
      },
    }) as const;
  const api = {} as Record<string, unknown>;
  for (const name of Object.keys(resources)) {
    api[name] = {
      add: fail,
      set: fail,
      get: fail,
      update: fail,
      delete: fail,
      list: fail,
    };
  }
  return api as ClientOf<TResources>;
}

function toWireError(err: unknown): WireFailure {
  if (err instanceof SchemaValidationError || err instanceof FireError) {
    return { ok: false, error: toFireFailure(err) };
  }
  return {
    ok: false,
    error: {
      kind: "operation",
      code: "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
      status: 500,
    },
  };
}

function statusOf(err: unknown): number {
  if (err instanceof FireError) return err.status;
  if (err instanceof SchemaValidationError) return 400;
  return 500;
}
