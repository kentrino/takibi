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
import { TakibiError, NotFoundError } from "./errors";
import { createTrustedCollections, executeOperation, type ExecuteRequest } from "./executor";
import {
  decodePublicHttp,
  decodePublicRoute,
  matchesPublicPrefix,
  type PublicRequest,
} from "./http";
import { createPolicyHelper } from "./policy";
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
 * Application-owned trust boundary: verify credentials, authorize the selected
 * storage partition, and return a complete context. The library treats the
 * result as trusted Worker-side values and never overlays request body / client
 * headers.
 *
 * Mirrors oRPC's initial vs execution context:
 * - input `context` (`TInitial`) — supplied at `handler.handle(..., { context })`
 * - returned `TCtx` — forwarded unchanged to policies, actions, and `stub.resolved`
 *
 * @see https://orpc.dev/docs/context
 */
export type ContextResolverInput<TInitial = Record<string, never>> = {
  request: Request;
  context: TInitial;
};

export type ContextResolver<TCtx extends object, TInitial = Record<string, never>> = (
  input: ContextResolverInput<TInitial>,
) => TCtx | Promise<TCtx>;

/**
 * Resolve a Durable Object **stub** for this request (after `resolve`).
 * `resolved` is the complete application-owned execution context.
 *
 * @example
 * stub: ({ context, resolved }) => {
 *   const ns = context.env.TENANT_STORE;
 *   return ns.get(ns.idFromName(resolved.clinic.slug));
 * }
 */
export type ContextStubResolverInput<
  TCtx extends object,
  TInitial = Record<string, never>,
> = ContextResolverInput<TInitial> & { resolved: TCtx };

export type ContextStubResolver<TCtx extends object, TInitial = Record<string, never>> = (
  input: ContextStubResolverInput<TCtx, TInitial>,
) => DurableObjectStub | Promise<DurableObjectStub>;

export type ContextConfig<TCtx extends object, TInitial = Record<string, never>> = {
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
  TCtx extends object,
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
  TCtx extends object = Record<string, unknown>,
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TRootActions extends ActionDefinitions = Record<never, never>,
> = Hono<{ Bindings: Record<string, unknown> }> &
  TakibiBrand<TCtx, TCollections, TInitial, TRootActions>;

type CreateContextBuilder<TCtx extends object, TInitial> = {
  /**
   * Type-safe `accessPolicy`. Pass a schema to bind `doc` / `nextDoc`; omit it
   * for rules that only use application context. Return a grant
   * (`fullAccess` / `write` / `read` / `none` / `grant(...)`).
   */
  policy: PolicyHelper<TCtx>;
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

type CreateContextFn<TInitial> = <R extends object | Promise<object>>(config: {
  resolve: (input: ContextResolverInput<TInitial>) => R;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<Awaited<R>, TInitial>;
}) => CreateContextBuilder<Awaited<R>, TInitial>;

/**
 * Bind typed initial context (`handle(..., { context })` deps), then call the
 * returned factory with `{ resolve, stub? }`. Execution context is inferred
 * from `resolve`'s return type.
 *
 * @example
 * const takibi = createTakibi<Initial>()({
 *   resolve: async ({ request, context }): Promise<AppCtx> => {
 *     const principal = await context.di.getSession(request)
 *     return { clinic: { slug: "acme" }, principal }
 *   },
 *   stub: ({ context, resolved }) => {
 *     const ns = context.env.TENANT_STORE
 *     return ns.get(ns.idFromName(resolved.clinic.slug))
 *   },
 * })
 */
export function createTakibi<TInitial = Record<string, never>>(): CreateContextFn<TInitial> {
  return ((config) =>
    buildContext(config as ContextConfig<object, TInitial>)) as CreateContextFn<TInitial>;
}

function buildContext<TInitial>(
  config: ContextConfig<object, TInitial>,
): CreateContextBuilder<object, TInitial> {
  const { resolve, stub: resolveStub } = config;

  return {
    policy: createPolicyHelper(),
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
      const collectionEntries: Array<[string, CollectionsDef<object>[string]]> = [];
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
        collectionEntries.push([propertyKey, descriptor.value as CollectionsDef<object>[string]]);
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
          const ctx = await resolve(input);
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
              "Durable Object mode requires stub on createTakibi()({ stub }) — or use collections(..., { memory: true }) for tests",
              500,
            );
          }

          const doStub = await resolveStub({ ...input, resolved: ctx });
          if (!doStub || typeof doStub.fetch !== "function") {
            throw new TakibiError(
              "MISSING_STUB",
              "createTakibi()({ stub }) did not return a Durable Object stub (use namespace.get(id))",
              500,
            );
          }

          const wire: WireRequest = {
            ...invocation,
            context: ctx,
          };

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
      const handler = app as TakibiHandler<object, typeof collections, TInitial>;
      Object.defineProperty(handler, "~takibi", {
        value: {
          context: null as unknown as object,
          initial: null as unknown as TInitial,
          collections,
          actions: rootActions,
        },
        enumerable: false,
      });
      handler.DurableObject = DurableObjectClass as TakibiHandler<
        object,
        typeof collections,
        TInitial
      >["DurableObject"];
      handler.defineAction = () =>
        createActionBuilder<object, "root", RootActionArgs<object, typeof collections>>("root");
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
        const ctx = context;
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

function assertSerializableContext(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TakibiError("INVALID_CONTEXT", "Resolved context must be a plain object", 500);
  }
  assertSerializableValue(value, new Set<object>());
}

function assertSerializableValue(value: unknown, seen: Set<object>): void {
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
      assertSerializableValue(descriptor.value, seen);
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
    assertSerializableValue(descriptor.value, seen);
  }
  seen.delete(value);
}
