import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Hono } from "hono";
import {
  ActionRegistry,
  assertCollectionName,
  createActionBuilder,
  defineCollection as defineCollectionValue,
  getCollectionActions,
} from "./action";
import type {
  ActionBuilder,
  ActionDefinitions,
  CollectionDefinitionInput,
  InvalidPublicKeys,
  ReservedPublicName,
  RootActionArgs,
} from "./action";
import { executeAction, type ActionInvocation } from "./action-executor";
import { TakibiError, NotFoundError, UnauthorizedError } from "./errors";
import { createTrustedCollections, executeOperation, type ExecuteRequest } from "./executor";
import {
  decodePublicHttp,
  decodePublicRoute,
  matchesPublicPrefix,
  type PublicRequest,
} from "./http";
import { and, createPolicyHelper, or } from "./policy";
import type { PolicyHelper } from "./policy";
import {
  decodeWireRequest,
  type WireFailure,
  type WireRequest,
  type WireResponse,
} from "./protocol";
import { toTakibiFailure } from "./result";
import { SchemaValidationError } from "./schema";
import { createDurableObjectStorage, createMemoryStorage } from "./storage";
import { storageAdd } from "./typed-storage";
import { collectionActionsBrand } from "./types";
import type { CollectionDefinition, CollectionsApi, CollectionsDef, StorageDriver } from "./types";

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

export type CollectionsOptions = {
  /** In-memory mode for tests / demos (skips Durable Object). */
  memory?: boolean;
};

export type HandleOptions<TInitial> = {
  /**
   * Path prefix for REST routes (e.g. `/api/takibi` matches `/api/takibi/posts`
   * and `/api/takibi/posts/{id}`, but not `/api/takibihose`). Omit to read
   * collection / id from the whole pathname.
   */
  prefix?: string;
} & (Record<string, never> extends TInitial ? { context?: TInitial } : { context: TInitial });

export type HandleResult =
  | { matched: true; response: Response }
  | { matched: false; response?: undefined };

export type TakibiBrand<
  TCtx extends { tenantId: string; user: unknown },
  TCollections,
  TInitial = Record<string, never>,
  TRootActions extends ActionDefinitions = Record<never, never>,
> = {
  readonly "~takibi": {
    context: TCtx;
    initial: TInitial;
    collections: TCollections;
    actions: TRootActions;
  };
  DurableObject: new (
    state: DurableObjectState,
    env: unknown,
  ) => DurableObject & { $collections: CollectionsApi<TCollections> };
  defineAction(): ActionBuilder<TCtx, "root", RootActionArgs<TCtx, TCollections>>;
  actions<const TActions extends ActionDefinitions>(
    definitions: TActions &
      Record<
        | Extract<keyof TActions, keyof TCollections | keyof TRootActions | ReservedPublicName>
        | InvalidPublicKeys<TActions>,
        never
      >,
  ): TakibiHandler<TCtx, TCollections, TInitial, TRootActions & TActions>;
  /**
   * oRPC-style entry: pass framework deps as typed initial `context`.
   * Prefer this over `app.route` when AuthN needs DI / request-scoped services.
   */
  handle(request: Request, options: HandleOptions<TInitial>): Promise<HandleResult>;
};

export type TakibiHandler<
  TCtx extends { tenantId: string; user: unknown } = { tenantId: string; user: unknown },
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TRootActions extends ActionDefinitions = Record<never, never>,
> = Hono<{ Bindings: Record<string, unknown> }> &
  TakibiBrand<TCtx, TCollections, TInitial, TRootActions>;

type TakibiCtxConstraint = { tenantId: string; user: unknown };

type CreateContextBuilder<TCtx extends TakibiCtxConstraint, TInitial> = {
  /**
   * Type-safe `accessPolicy`. Pass a schema to bind `doc` / `nextDoc`; omit it
   * for rules that only use execution context (`user`, …). Return a grant
   * (`fullAccess` / `write` / `read` / `none` / `grant(...)`).
   */
  policy: PolicyHelper<TCtx>;
  and: typeof and;
  or: typeof or;
  defineCollection<
    TSchema extends StandardSchemaV1,
    const TActions extends ActionDefinitions = Record<never, never>,
  >(
    definition: CollectionDefinitionInput<TSchema, TCtx, TActions>,
  ): CollectionDefinition<TSchema, TCtx, TActions> & {
    readonly [collectionActionsBrand]: TActions;
  };
  collections<const TCollections extends CollectionsDef<TCtx>>(
    collections: TCollections,
    options?: CollectionsOptions,
    ...invalidName: [
      Extract<keyof TCollections, ReservedPublicName> | InvalidPublicKeys<TCollections>,
    ] extends [never]
      ? []
      : ["Collection names must be safe TypeScript identifiers"]
  ): TakibiHandler<TCtx, TCollections, TInitial>;
};

type CreateContextFn<TInitial> = <
  R extends TakibiCtxConstraint | Promise<TakibiCtxConstraint>,
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
      config as ContextConfig<TakibiCtxConstraint, TInitial>,
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
  config: ContextConfig<TakibiCtxConstraint, TInitial>,
): CreateContextBuilder<TakibiCtxConstraint, TInitial> {
  const { resolve, stub: resolveStub } = config;

  return {
    policy: createPolicyHelper(),
    and,
    or,
    defineCollection: defineCollectionValue,
    collections(collections, options: CollectionsOptions = {}) {
      const registry = new ActionRegistry();
      if (typeof collections !== "object" || collections === null) {
        throw new TakibiError("INVALID_COLLECTION", "Collections must be an object", 500);
      }
      const prototype = Object.getPrototypeOf(collections);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TakibiError("INVALID_COLLECTION", "Collections must be a plain object", 500);
      }
      const collectionEntries: Array<[string, CollectionsDef<TakibiCtxConstraint>[string]]> = [];
      for (const propertyKey of Reflect.ownKeys(collections)) {
        if (typeof propertyKey !== "string") {
          throw new TakibiError("INVALID_COLLECTION", "Collection names must be strings", 500);
        }
        const descriptor = Object.getOwnPropertyDescriptor(collections, propertyKey);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TakibiError(
            "INVALID_COLLECTION",
            `Collections must be enumerable data properties: ${propertyKey}`,
            500,
          );
        }
        collectionEntries.push([
          propertyKey,
          descriptor.value as CollectionsDef<TakibiCtxConstraint>[string],
        ]);
      }
      const collectionNames = new Set(collectionEntries.map(([name]) => name));
      for (const [name, definition] of collectionEntries) {
        assertCollectionName(name);
        if (
          Object.prototype.hasOwnProperty.call(definition, "actions") &&
          getCollectionActions(definition) === null
        ) {
          throw new TakibiError(
            "INVALID_COLLECTION",
            `Collection actions require defineCollection(): ${name}`,
            500,
          );
        }
        const definitions = getCollectionActions(definition);
        if (definitions) registry.registerCollectionActions(name, definitions);
      }
      const memory = options.memory ?? false;

      const app = new Hono<{ Bindings: Record<string, unknown> }>();

      const memoryDriver = memory ? createMemoryStorage() : null;
      const memoryReady = memoryDriver
        ? seedCollections(collections, memoryDriver)
        : Promise.resolve();

      const run = async (
        request: Request,
        initial: unknown,
        invocation: PublicRequest,
      ): Promise<Response> => {
        try {
          await memoryReady;
          const input = { request, context: initial as TInitial };
          const ctx = (await resolve(input)) as TakibiCtxConstraint;
          if (!ctx.tenantId) {
            throw new UnauthorizedError("Missing tenantId");
          }
          assertSerializableContext(ctx);

          if (memoryDriver) {
            const data =
              invocation.kind === "action"
                ? await executeAction(registry, collections, memoryDriver, ctx, invocation)
                : await executeOperation(collections, memoryDriver, ctx, invocation);
            return Response.json({ ok: true, data } satisfies WireResponse);
          }

          if (!resolveStub) {
            throw new TakibiError(
              "MISSING_STUB",
              "Durable Object mode requires stub on fire.initialContext()({ stub }) — or use collections(..., { memory: true }) for tests",
              500,
            );
          }

          const doStub = await resolveStub({ ...input, tenantId: ctx.tenantId });
          if (!doStub || typeof doStub.fetch !== "function") {
            throw new TakibiError(
              "MISSING_STUB",
              "fire.initialContext()({ stub }) did not return a Durable Object stub (use namespace.get(id))",
              500,
            );
          }

          const wire: WireRequest = { ...invocation, context: ctx };

          const res = await doStub.fetch(
            new Request("https://takibi.internal/", {
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

      const serveDecoded = async (
        request: Request,
        initial: unknown,
        decode: () => Promise<PublicRequest>,
      ): Promise<Response> => {
        try {
          const op = await decode();
          return await run(request, initial, op);
        } catch (err) {
          return Response.json(toWireError(err), { status: statusOf(err) });
        }
      };

      const mountPublicRoute = (path: string, extra = false) => {
        app.all(path, async (c) => {
          const response = extra
            ? Response.json(toWireError(new NotFoundError()), { status: 404 })
            : await serveDecoded(c.req.raw, {}, () =>
                decodePublicRoute(
                  c.req.method,
                  [c.req.param("collection"), c.req.param("id")].filter(
                    (segment): segment is string => segment != null && segment !== "",
                  ),
                  new URL(c.req.url).searchParams,
                  () => (c.req.raw.body === null ? Promise.resolve(undefined) : c.req.json()),
                ),
              );
          return c.newResponse(response.body, response);
        });
      };

      // Hono mount: empty initial. Prefer `handle` when AuthN / stub need deps.
      mountPublicRoute("/:collection");
      mountPublicRoute("/:collection/:id");
      mountPublicRoute("/:collection/:id/*", true);
      app.all("/", async (c) => {
        const response = await serveDecoded(c.req.raw, {}, () => decodePublicHttp(c.req.raw));
        return c.newResponse(response.body, response);
      });

      const DurableObjectClass = createDurableObjectClass(collections, registry);

      const rootActions = Object.create(null) as ActionDefinitions;
      const handler = app as TakibiHandler<TakibiCtxConstraint, typeof collections, TInitial>;
      Object.defineProperty(handler, "~takibi", {
        value: {
          context: null as unknown as TakibiCtxConstraint,
          initial: null as unknown as TInitial,
          collections,
          actions: rootActions,
        },
        enumerable: false,
      });
      handler.DurableObject = DurableObjectClass as TakibiHandler<
        TakibiCtxConstraint,
        typeof collections,
        TInitial
      >["DurableObject"];
      handler.defineAction = () =>
        createActionBuilder<
          TakibiCtxConstraint,
          "root",
          RootActionArgs<TakibiCtxConstraint, typeof collections>
        >("root");
      handler.actions = ((definitions: ActionDefinitions) => {
        registry.registerRootActions(definitions, collectionNames);
        return handler;
      }) as typeof handler.actions;
      handler.handle = async (request, handleOptions) => {
        if (!matchesPublicPrefix(new URL(request.url).pathname, handleOptions.prefix)) {
          return { matched: false };
        }

        const initial =
          "context" in handleOptions && handleOptions.context !== undefined
            ? handleOptions.context
            : {};
        const response = await serveDecoded(request, initial, () =>
          decodePublicHttp(request, handleOptions.prefix),
        );
        return { matched: true, response };
      };
      return handler;
    },
  };
}

function createDurableObjectClass<TCollections extends CollectionsDef>(
  collections: TCollections,
  registry: ActionRegistry,
) {
  return class TakibiTenantObject implements DurableObject {
    readonly #driver: StorageDriver;
    readonly #ready: Promise<void>;
    readonly $collections: CollectionsApi<TCollections>;

    constructor(state: DurableObjectState, _env: unknown) {
      this.#driver = createDurableObjectStorage(state.storage);
      this.#ready = state.blockConcurrencyWhile(() => seedCollections(collections, this.#driver));
      this.$collections = createTrustedCollections(
        collections,
        afterInitialization(this.#driver, this.#ready),
      );
    }

    async fetch(request: Request): Promise<Response> {
      try {
        await this.#ready;
        const body = decodeWireRequest(await request.json());
        const { context, ...invocation } = body;
        const ctx = context as { tenantId: string; user: unknown };
        const data =
          invocation.kind === "action"
            ? await executeAction(
                registry,
                collections,
                this.#driver,
                ctx,
                invocation as ActionInvocation,
              )
            : await executeOperation(collections, this.#driver, ctx, invocation as ExecuteRequest);
        return Response.json({ ok: true, data } satisfies WireResponse);
      } catch (err) {
        const wire = toWireError(err);
        return Response.json(wire, { status: wire.error.status });
      }
    }
  };
}

async function seedCollections(
  collections: Record<string, CollectionDefinition>,
  driver: StorageDriver,
): Promise<void> {
  for (const [collection, definition] of Object.entries(collections)) {
    if (!definition.seed) continue;

    const documents = await definition.seed();
    for (const [id, data] of Object.entries(documents)) {
      if (await driver.get(collection, id)) continue;
      await storageAdd(definition, driver, collection, data, { id });
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

function toWireError(err: unknown): WireFailure {
  if (err instanceof SchemaValidationError || err instanceof TakibiError) {
    return { ok: false, error: toTakibiFailure(err) };
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
  if (err instanceof TakibiError) return err.status;
  if (err instanceof SchemaValidationError) return 400;
  return 500;
}

function assertSerializableContext(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new TakibiError("INVALID_CONTEXT", "Resolved context must be JSON-safe", 500);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TakibiError("INVALID_CONTEXT", "Resolved context arrays must contain data", 500);
      }
      assertSerializableContext(descriptor.value, seen);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw new TakibiError(
          "INVALID_CONTEXT",
          "Resolved context arrays must not have custom properties",
          500,
        );
      }
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TakibiError("INVALID_CONTEXT", "Resolved context must use plain objects", 500);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TakibiError("INVALID_CONTEXT", "Resolved context must not contain symbols", 500);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TakibiError(
        "INVALID_CONTEXT",
        "Resolved context must contain only enumerable data properties",
        500,
      );
    }
    assertSerializableContext(descriptor.value, seen);
  }
  seen.delete(value);
}
