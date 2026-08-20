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
import { ForbiddenError, TakibiError, NotFoundError } from "./errors";
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
  isWireResponse,
  type WireFailure,
  type WireRequest,
  type WireResponse,
} from "./protocol";
import { assertCollectionMigrations, createMigratingStorage } from "./migrations";
import { toTakibiFailure } from "./result";
import { SchemaValidationError } from "./schema";
import { createDurableObjectStorage, createMemoryStorage } from "./storage";
import {
  activeSpanContext,
  bindTracer,
  extractSpanContext,
  injectTraceparent,
  internalTracerKey,
  resolveTracer,
  tracedStorage,
  withSpan,
  type SpanAttributes,
  type SpanContext,
  type TakibiTracer,
} from "./tracing";
import { storageAdd } from "./typed-storage";
import { collectionActionsBrand } from "./types";
import type {
  CollectionDefinition,
  CollectionsApi,
  CollectionsDef,
  ReservedDocumentSchemaConstraint,
  StorageDriver,
} from "./types";

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
 * Name the object with `idFromName(resolved.tenantId)` — the same string as
 * `tenantId`, with no prefix. `fetch` on the generated class is for this stub
 * only; do not route public HTTP to it. Identity stays whatever `resolve`
 * returned; the Durable Object does not re-verify the caller.
 *
 * @example
 * stub: ({ context, resolved }) => {
 *   const ns = context.env.TENANT_STORE;
 *   return ns.get(ns.idFromName(resolved.tenantId));
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

type InternalCollectionsOptions = CollectionsOptions & {
  [internalTracerKey]?: TakibiTracer;
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
  /**
   * Fork a handler for tests: same collections / actions, new memory store,
   * optional `resolve` override. The original handler is unchanged.
   */
  with(options: {
    memory: true;
    resolve?: (input: ContextResolverInput<TInitial>) => TCtx | Promise<TCtx>;
  }): TakibiHandler<TCtx, TCollections, TInitial, TRootActions>;
};

export type TakibiHandler<
  TCtx extends object = Record<string, unknown>,
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TRootActions extends ActionDefinitions = Record<never, never>,
> = Hono<{ Bindings: Record<string, unknown> }> &
  TakibiBrand<TCtx, TCollections, TInitial, TRootActions>;

/**
 * Per-key public constraint. Depends on each entry's own type so `const`
 * inference is not forced to a shared `CollectionDefinition<any>`. The action
 * brand is omitted so `defineCollection()` brands stay on those entries only.
 */
type PublicCollectionConstraint<C, TCtx extends object> = C extends {
  schema: infer S extends StandardSchemaV1;
}
  ? {
      schema: CollectionDefinition<S, TCtx>["schema"];
      accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
      migrations?: CollectionDefinition<S, TCtx>["migrations"];
      seed?: CollectionDefinition<S, TCtx>["seed"];
    } & ReservedDocumentSchemaConstraint<S>
  : {
      schema: StandardSchemaV1;
      accessPolicy: CollectionDefinition<StandardSchemaV1, TCtx>["accessPolicy"];
    };

type PublicCollectionsMap<TCollections, TCtx extends object> = {
  [K in keyof TCollections]: PublicCollectionConstraint<TCollections[K], TCtx>;
};

/**
 * `CollectionsDef` uses `CollectionDefinition<any>`, which erases schema-bound
 * checks. Re-bind each collection's policy and migrations to that collection's
 * schema.
 */
type CollectionsWithMatchingDefinitions<TCollections, TCtx extends object> = {
  [K in keyof TCollections]: TCollections[K] extends { schema: infer S extends StandardSchemaV1 }
    ? Omit<TCollections[K], "schema" | "accessPolicy" | "migrations"> & {
        schema: CollectionDefinition<S, TCtx>["schema"];
        accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
        migrations?: CollectionDefinition<S, TCtx>["migrations"];
      } & ReservedDocumentSchemaConstraint<S>
    : TCollections[K];
};

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
  collections<const TCollections extends PublicCollectionsMap<TCollections, TCtx>>(
    collections: TCollections & CollectionsWithMatchingDefinitions<TCollections, TCtx>,
    options?: InternalCollectionsOptions,
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
 *     return { tenantId: "acme", principal }
 *   },
 *   stub: ({ context, resolved }) => {
 *     const ns = context.env.TENANT_STORE
 *     return ns.get(ns.idFromName(resolved.tenantId))
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
    collections(collections, options: InternalCollectionsOptions = {}) {
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
        assertCollectionMigrations(definition, name);
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
      return assembleHandler({
        collections,
        registry,
        collectionNames,
        resolve,
        resolveStub,
        options,
      });
    },
  };
}

function assembleHandler<TInitial, TCollections extends CollectionsDef<object>>(args: {
  collections: TCollections;
  registry: ActionRegistry;
  collectionNames: Set<string>;
  resolve: ContextResolver<object, TInitial>;
  resolveStub?: ContextStubResolver<object, TInitial>;
  options: InternalCollectionsOptions;
}): TakibiHandler<object, TCollections, TInitial> {
  const { collections, registry, collectionNames, resolve, resolveStub, options } = args;
  const memory = options.memory ?? false;
  const app = new Hono<{ Bindings: Record<string, unknown> }>();

  const memoryDriver = memory ? createMigratingStorage(collections, createMemoryStorage()) : null;
  const memoryReady = memoryDriver ? seedCollections(collections, memoryDriver) : Promise.resolve();

  const run = async (
    request: Request,
    initial: unknown,
    invocation: PublicRequest,
  ): Promise<Response> => {
    const execute = async (): Promise<Response> => {
      const tracer = resolveTracer(options);
      try {
        await memoryReady;
        const input = { request, context: initial as TInitial };
        let resolveSpan: SpanContext | undefined;
        const ctx = await withSpan({ name: "takibi.resolve", kind: "internal" }, async () => {
          resolveSpan = activeSpanContext();
          const resolved = await resolve(input);
          assertSerializableContext(resolved);
          return resolved;
        });

        if (memoryDriver) {
          const driver = tracer ? tracedStorage(memoryDriver) : memoryDriver;
          const data = await withSpan(
            {
              name: "takibi.executor",
              kind: "internal",
              attributes: invocationSpanAttributes(invocation),
            },
            () =>
              invocation.kind === "action"
                ? executeAction(registry, collections, driver, ctx, invocation)
                : executeOperation(collections, driver, ctx, invocation),
            resolveSpan,
          );
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

        const json = await withSpan(
          {
            name: "takibi.wire",
            kind: "client",
            attributes: invocationSpanAttributes(invocation),
          },
          async () => {
            const headers = new Headers({ "content-type": "application/json" });
            injectTraceparent(headers);
            const res = await doStub.fetch(
              new Request("https://takibi.internal/", {
                method: "POST",
                headers,
                body: JSON.stringify(wire),
              }),
            );
            const body: unknown = await res.json();
            if (!isWireResponse(body)) {
              throw new Error("Invalid response from Durable Object");
            }
            return body;
          },
          resolveSpan,
        );
        return Response.json(json, { status: json.ok ? 200 : json.error.status });
      } catch (err) {
        return Response.json(toWireError(err), { status: statusOf(err) });
      }
    };
    const tracer = resolveTracer(options);
    return tracer ? bindTracer(tracer, execute) : execute();
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

  const DurableObjectClass = createDurableObjectClass(collections, registry, options);

  const rootActions = Object.create(null) as ActionDefinitions;
  const handler = app as TakibiHandler<object, TCollections, TInitial>;
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
    TCollections,
    TInitial
  >["DurableObject"];
  handler.defineAction = () =>
    createActionBuilder<object, "root", RootActionArgs<object, TCollections>>("root");
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
  handler.with = ((withOptions: { memory: true; resolve?: ContextResolver<object, TInitial> }) =>
    assembleHandler({
      collections,
      registry: registry.clone(),
      collectionNames,
      resolve: withOptions.resolve ?? resolve,
      options: { ...options, memory: true },
    })) as typeof handler.with;
  return handler;
}

function createDurableObjectClass<TCollections extends CollectionsDef>(
  collections: TCollections,
  registry: ActionRegistry,
  options: InternalCollectionsOptions,
) {
  return class TakibiTenantObject implements DurableObject {
    readonly #state: DurableObjectState;
    readonly #driver: StorageDriver;
    readonly #ready: Promise<void>;
    readonly $collections: CollectionsApi<TCollections>;

    constructor(state: DurableObjectState, _env: unknown) {
      this.#state = state;
      this.#driver = createMigratingStorage(collections, createDurableObjectStorage(state.storage));
      this.#ready = state.blockConcurrencyWhile(() => seedCollections(collections, this.#driver));
      this.$collections = createTrustedCollections(
        collections,
        afterInitialization(this.#driver, this.#ready),
      );
    }

    async fetch(request: Request): Promise<Response> {
      const tracer = resolveTracer(options);
      const execute = async (): Promise<Response> => {
        try {
          const body = decodeWireRequest(await request.json());
          const { context, ...invocation } = body;
          assertTenantMatchesDurableObjectName(this.#state.id.name, context);
          await this.#ready;
          const ctx = context;
          const driver = tracer ? tracedStorage(this.#driver) : this.#driver;
          const parent = extractSpanContext(request.headers);
          const data = await withSpan(
            {
              name: "takibi.executor",
              kind: "server",
              attributes: invocationSpanAttributes(invocation),
            },
            () =>
              invocation.kind === "action"
                ? executeAction(registry, collections, driver, ctx, invocation as ActionInvocation)
                : executeOperation(collections, driver, ctx, invocation as ExecuteRequest),
            parent,
          );
          return Response.json({ ok: true, data } satisfies WireResponse);
        } catch (err) {
          const wire = toWireError(err);
          return Response.json(wire, { status: wire.error.status });
        }
      };
      return tracer ? bindTracer(tracer, execute) : execute();
    }
  };
}

function invocationSpanAttributes(invocation: PublicRequest): SpanAttributes {
  if (invocation.kind === "action") {
    return {
      "takibi.action.name": invocation.name,
      "takibi.action.scope": invocation.scope,
    };
  }
  return {
    "takibi.collection.name": invocation.collection,
    "takibi.operation.name": invocation.operation,
    ...(invocation.id === undefined ? {} : { "takibi.document.id": invocation.id }),
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
    async list(resource, options, plan) {
      await ready;
      return driver.list(resource, options, plan);
    },
    async transaction(callback) {
      await ready;
      return driver.transaction(callback);
    },
  };
}

function assertTenantMatchesDurableObjectName(
  name: string | undefined,
  context: Record<string, unknown>,
): void {
  if (typeof name === "string" && name.length > 0 && name !== context.tenantId) {
    throw new ForbiddenError("Tenant mismatch");
  }
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
