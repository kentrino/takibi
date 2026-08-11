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

/**
 * Application-owned trust boundary: verify credentials, authorize tenant
 * membership, and return a complete context. The library treats the result as
 * trusted Worker-side values and never overlays request body / client headers.
 */
export type ContextResolver<TCtx> = (input: { request: Request }) => TCtx | Promise<TCtx>;

export type ContextConfig<TCtx extends { tenantId: string; user: unknown }> = {
  resolve: ContextResolver<TCtx>;
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

export function createContext<TCtx extends { tenantId: string; user: unknown }>(
  config: ContextConfig<TCtx>,
) {
  const { resolve } = config;

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
