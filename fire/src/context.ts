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
 * Return the Durable Object namespace for this request. Fire calls
 * `idFromName(tenantId)` on the result — pick the binding yourself from
 * initial context (e.g. `context.env.TENANT_STORE`).
 */
export type ContextStubResolver<TInitial = Record<string, never>> = (
  input: ContextResolverInput<TInitial>,
) => DurableObjectNamespace | Promise<DurableObjectNamespace>;

export type ContextConfig<
  TCtx extends { tenantId: string; user: unknown },
  TInitial = Record<string, never>,
> = {
  resolve: ContextResolver<TCtx, TInitial>;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<TInitial>;
};

export type ResourcesOptions = {
  /**
   * Fallback DO binding name for the Hono `app.route` mount when `stub` is
   * omitted (tests / demos). Defaults to `TENANT_STORE`. Prefer `stub`.
   */
  binding?: string;
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

export function createContext<
  TCtx extends { tenantId: string; user: unknown },
  TInitial = Record<string, never>,
>(config: ContextConfig<TCtx, TInitial>) {
  const { resolve, stub: resolveStub } = config;

  return {
    resources<const TResources extends ResourcesDef<TCtx>>(
      resources: TResources,
      options: ResourcesOptions = {},
    ): FireHandler<TCtx, TResources, TInitial> {
      const binding = options.binding ?? "TENANT_STORE";
      const memory = options.memory ?? false;

      const app = new Hono<{ Bindings: Record<string, unknown> }>();

      const memoryDriver = memory ? createMemoryStorage() : null;
      const storageApi = memoryDriver
        ? createTypedStorage(resources, memoryDriver)
        : createUnavailableStorage(resources);

      const run = async (
        request: Request,
        initial: TInitial,
        fallbackEnv?: object,
      ): Promise<Response> => {
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
          const input = { request, context: initial };
          const ctx = await resolve(input);
          if (!ctx.tenantId) {
            throw new UnauthorizedError("Missing tenantId");
          }

          const op = decodeWireRequest({ ...(body as object), context: ctx });

          if (memoryDriver) {
            const data = await executeOperation(resources, memoryDriver, ctx, op);
            return Response.json({ ok: true, data } satisfies WireResponse);
          }

          const ns = resolveStub
            ? await resolveStub(input)
            : ((fallbackEnv as Record<string, unknown> | undefined)?.[binding] as
                | DurableObjectNamespace
                | undefined);

          if (!ns || typeof ns.idFromName !== "function") {
            throw new FireError(
              "MISSING_BINDING",
              resolveStub
                ? "createContext({ stub }) did not return a Durable Object namespace"
                : `Durable Object binding "${binding}" not found — set createContext({ stub: ({ context }) => context.env.YOUR_DO })`,
              500,
            );
          }

          const doStub = ns.get(ns.idFromName(ctx.tenantId));
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
        // Hono mount: empty initial; without `stub`, falls back to c.env[binding].
        const response = await run(c.req.raw, {} as TInitial, c.env);
        return c.newResponse(response.body, response);
      });

      const DurableObjectClass = createDurableObjectClass(resources);

      const handler = app as FireHandler<TCtx, TResources, TInitial>;
      Object.defineProperty(handler, "~fire", {
        value: {
          context: null as unknown as TCtx,
          initial: null as unknown as TInitial,
          resources,
        },
        enumerable: false,
      });
      handler.storage = storageApi;
      handler.DurableObject = DurableObjectClass as FireHandler<
        TCtx,
        TResources,
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

        const initial = (
          "context" in handleOptions && handleOptions.context !== undefined
            ? handleOptions.context
            : {}
        ) as TInitial;
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
