import type { StandardSchemaV1 } from "@standard-schema/spec";
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
import { createTypedStorage, storageAdd } from "./typed-storage";
import type { ClientOf, ResourceDefinition, ResourcesDef, StorageDriver } from "./types";

/**
 * Application-owned trust boundary: verify credentials, authorize tenant
 * membership, and return a complete context. The library treats the result as
 * trusted Worker-side values and never overlays request body / client headers.
 *
 * Mirrors oRPC's initial vs execution context:
 * - input `context` (`TInitial`) — supplied at `handler.handle(..., { context })`
 * - returned `TCtx` — used by `accessPolicy` (`tenantId`, `user`, …)
 *
 * @see https://orpc.dev/docs/context
 */
export type ContextResolverInput<TInitial = Record<string, never>> = {
  request: Request;
  context: TInitial;
};

export type ContextResolver<TCtx, TInitial = Record<string, never>> = (
  input: ContextResolverInput<TInitial>,
) => TCtx | Promise<TCtx>;

/**
 * Resolve a Durable Object **stub** for this request (after `resolve`).
 * `tenantId` is taken from the resolved execution context (`Pick<TCtx, "tenantId">`).
 *
 * @example
 * stub: ({ context, tenantId }) => {
 *   const ns = context.env.TENANT_STORE;
 *   return ns.get(ns.idFromName(tenantId));
 * }
 */
export type ContextStubResolverInput<
  TCtx extends { tenantId: string; user: unknown },
  TInitial = Record<string, never>,
> = ContextResolverInput<TInitial> & Pick<TCtx, "tenantId">;

export type ContextStubResolver<
  TCtx extends { tenantId: string; user: unknown },
  TInitial = Record<string, never>,
> = (
  input: ContextStubResolverInput<TCtx, TInitial>,
) => DurableObjectStub | Promise<DurableObjectStub>;

export type ContextConfig<
  TCtx extends { tenantId: string; user: unknown },
  TInitial = Record<string, never>,
> = {
  resolve: ContextResolver<TCtx, TInitial>;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<TCtx, TInitial>;
};

export type ResourcesOptions = {
  /** In-memory mode for tests / demos (skips Durable Object). */
  memory?: boolean;
};

export type HandleOptions<TInitial> = {
  /** Path prefix to match (e.g. `/api/fire`). Omit to always match. */
  prefix?: string;
} & (Record<string, never> extends TInitial ? { context?: TInitial } : { context: TInitial });

export type HandleResult =
  | { matched: true; response: Response }
  | { matched: false; response?: undefined };

export type FireBrand<
  TCtx extends { tenantId: string; user: unknown },
  TResources,
  TInitial = Record<string, never>,
> = {
  readonly "~fire": {
    context: TCtx;
    initial: TInitial;
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
  /**
   * oRPC-style entry: pass framework deps as typed initial `context`.
   * Prefer this over `app.route` when AuthN needs DI / request-scoped services.
   */
  handle(request: Request, options: HandleOptions<TInitial>): Promise<HandleResult>;
};

export type FireHandler<
  TCtx extends { tenantId: string; user: unknown } = { tenantId: string; user: unknown },
  TResources = ResourcesDef<TCtx>,
  TInitial = Record<string, never>,
> = Hono<{ Bindings: Record<string, unknown> }> & FireBrand<TCtx, TResources, TInitial>;

type FireCtxConstraint = { tenantId: string; user: unknown };

type ResourceDefinitions<TSchemas extends Record<string, StandardSchemaV1>, TCtx> = {
  [K in keyof TSchemas]: ResourceDefinition<TSchemas[K], TCtx>;
};

type CreateContextBuilder<TCtx extends FireCtxConstraint, TInitial> = {
  resources<const TSchemas extends Record<string, StandardSchemaV1>>(
    resources: ResourceDefinitions<TSchemas, TCtx>,
    options?: ResourcesOptions,
  ): FireHandler<TCtx, ResourceDefinitions<TSchemas, TCtx>, TInitial>;
};

type CreateContextFn<TInitial> = <
  R extends FireCtxConstraint | Promise<FireCtxConstraint>,
>(config: {
  resolve: (input: ContextResolverInput<TInitial>) => R;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<Awaited<R>, TInitial>;
}) => CreateContextBuilder<Awaited<R>, TInitial>;

/**
 * Bind typed initial context (`handle(..., { context })` deps), then call the
 * returned `createContext` with `{ resolve, stub? }`. Execution context is
 * inferred from `resolve`'s return type.
 *
 * @example
 * const createContext = fire.initialContext<Initial>()
 * const app = createContext({
 *   resolve: async ({ request, context }): Promise<AppCtx> => {
 *     const user = await context.di.getSession(request)
 *     return { tenantId: "acme", user }
 *   },
 *   stub: ({ context, tenantId }) => {
 *     const ns = context.env.TENANT_STORE
 *     return ns.get(ns.idFromName(tenantId))
 *   },
 * })
 */
export function initialContext<TInitial = Record<string, never>>(): CreateContextFn<TInitial> {
  return ((config) =>
    buildContext(
      config as ContextConfig<FireCtxConstraint, TInitial>,
    )) as CreateContextFn<TInitial>;
}

/**
 * Namespace entry for context setup. Use `fire.initialContext<Initial>()`
 * (or `fire.initialContext()` when initial deps are empty).
 */
export const fire = {
  initialContext,
} as const;

function buildContext<TInitial>(
  config: ContextConfig<FireCtxConstraint, TInitial>,
): CreateContextBuilder<FireCtxConstraint, TInitial> {
  const { resolve, stub: resolveStub } = config;

  return {
    resources(resources, options: ResourcesOptions = {}) {
      const memory = options.memory ?? false;

      const app = new Hono<{ Bindings: Record<string, unknown> }>();

      const memoryDriver = memory ? createMemoryStorage() : null;
      const memoryReady = memoryDriver ? seedResources(resources, memoryDriver) : Promise.resolve();
      const storageApi = memoryDriver
        ? createTypedStorage(resources, afterInitialization(memoryDriver, memoryReady))
        : createUnavailableStorage(resources);

      const run = async (request: Request, initial: unknown): Promise<Response> => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            {
              ok: false,
              error: {
                kind: "operation",
                code: "BAD_REQUEST",
                message: "Expected JSON body",
                status: 400,
              },
            } satisfies WireResponse,
            { status: 400 },
          );
        }

        try {
          await memoryReady;
          const input = { request, context: initial as TInitial };
          const ctx = (await resolve(input)) as FireCtxConstraint;
          if (!ctx.tenantId) {
            throw new UnauthorizedError("Missing tenantId");
          }

          const op = decodeWireRequest({ ...(body as object), context: ctx });

          if (memoryDriver) {
            const data = await executeOperation(resources, memoryDriver, ctx, op);
            return Response.json({ ok: true, data } satisfies WireResponse);
          }

          if (!resolveStub) {
            throw new FireError(
              "MISSING_STUB",
              "Durable Object mode requires stub on fire.initialContext()({ stub }) — or use resources(..., { memory: true }) for tests",
              500,
            );
          }

          const doStub = await resolveStub({ ...input, tenantId: ctx.tenantId });
          if (!doStub || typeof doStub.fetch !== "function") {
            throw new FireError(
              "MISSING_STUB",
              "fire.initialContext()({ stub }) did not return a Durable Object stub (use namespace.get(id))",
              500,
            );
          }

          const wire: WireRequest = { ...op, context: ctx };

          const res = await doStub.fetch(
            new Request("https://fire.internal/", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(wire),
            }),
          );
          const json = (await res.json()) as WireResponse;
          return Response.json(json, { status: json.ok ? 200 : json.error.status });
        } catch (err) {
          return Response.json(toWireError(err), { status: statusOf(err) });
        }
      };

      app.post("/", async (c) => {
        // Hono mount: empty initial. Prefer `handle` when AuthN / stub need deps.
        const response = await run(c.req.raw, {});
        return c.newResponse(response.body, response);
      });

      const DurableObjectClass = createDurableObjectClass(resources);

      const handler = app as FireHandler<FireCtxConstraint, typeof resources, TInitial>;
      Object.defineProperty(handler, "~fire", {
        value: {
          context: null as unknown as FireCtxConstraint,
          initial: null as unknown as TInitial,
          resources,
        },
        enumerable: false,
      });
      handler.storage = storageApi;
      handler.DurableObject = DurableObjectClass as FireHandler<
        FireCtxConstraint,
        typeof resources,
        TInitial
      >["DurableObject"];
      handler.handle = async (request, handleOptions) => {
        if (!matchesPrefix(request, handleOptions.prefix)) {
          return { matched: false };
        }
        if (request.method !== "POST") {
          return {
            matched: true,
            response: Response.json(
              {
                ok: false,
                error: {
                  kind: "operation",
                  code: "METHOD_NOT_ALLOWED",
                  message: "Expected POST",
                  status: 405,
                },
              } satisfies WireResponse,
              { status: 405 },
            ),
          };
        }

        const initial =
          "context" in handleOptions && handleOptions.context !== undefined
            ? handleOptions.context
            : {};
        const response = await run(request, initial);
        return { matched: true, response };
      };
      return handler;
    },
  };
}

function matchesPrefix(request: Request, prefix: string | undefined): boolean {
  if (prefix == null || prefix === "") return true;
  const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
  const normalized = prefix.replace(/\/$/, "") || "/";
  return pathname === normalized;
}

function createDurableObjectClass<TResources extends Record<string, ResourceDefinition>>(
  resources: TResources,
) {
  return class FireTenantObject implements DurableObject {
    readonly #driver: StorageDriver;
    readonly #ready: Promise<void>;
    readonly storage: ClientOf<TResources>;

    constructor(state: DurableObjectState, _env: unknown) {
      this.#driver = createDurableObjectStorage(state.storage);
      this.#ready = state.blockConcurrencyWhile(() => seedResources(resources, this.#driver));
      this.storage = createTypedStorage(resources, afterInitialization(this.#driver, this.#ready));
    }

    async fetch(request: Request): Promise<Response> {
      try {
        await this.#ready;
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

async function seedResources(
  resources: Record<string, ResourceDefinition>,
  driver: StorageDriver,
): Promise<void> {
  for (const [resource, definition] of Object.entries(resources)) {
    if (!definition.seed) continue;

    const documents = await definition.seed();
    for (const [id, data] of Object.entries(documents)) {
      if (await driver.get(resource, id)) continue;
      await storageAdd(definition, driver, resource, data, { id });
    }
  }
}

function afterInitialization(driver: StorageDriver, ready: Promise<void>): StorageDriver {
  return {
    async get(resource, id) {
      await ready;
      return driver.get(resource, id);
    },
    async put(resource, doc) {
      await ready;
      return driver.put(resource, doc);
    },
    async delete(resource, id) {
      await ready;
      return driver.delete(resource, id);
    },
    async list(resource, options) {
      await ready;
      return driver.list(resource, options);
    },
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
