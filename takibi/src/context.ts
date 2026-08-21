import { Hono } from "hono";
import {
  ActionRegistry,
  assertCollectionName,
  assertNoActionsOption,
  createDocumentActionBuilder,
  createRootActionBuilder,
  defineCollection as defineCollectionValue,
  type ActionDefinitions,
} from "./action";
import { executeAction } from "./action-executor";
import {
  assertSerializableContext,
  applyStorageLogging,
  debugInvocationFields,
  errorResponse,
  invocationFields,
  mergeLoggingOptions,
} from "./context-runtime";
import type {
  ActionScopeMap,
  AppDefinition,
  ContextConfig,
  ContextResolver,
  ContextStubResolver,
  CreateContextBuilder,
  CreateContextFn,
  InternalCollectionsOptions,
  TakibiHandler,
} from "./context-types";
import { createDurableObjectClass, seedCollections } from "./durable-object";
import { NotFoundError, TakibiError } from "./errors";
import { executeOperation } from "./executor";
import {
  decodePublicHttp,
  decodePublicRoute,
  matchesPublicPrefix,
  rawPathSegments,
  type PublicRequest,
} from "./http";
import { resolveLogging, withLoggedSpan, type LoggingOptions } from "./logging";
import { assertCollectionMigrations, createMigratingStorage } from "./migrations";
import { invocationSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { createPolicyHelper } from "./policy";
import { isWireResponse, type WireRequest, type WireResponse } from "./protocol";
import { createMemoryStorage } from "./storage";
import {
  activeSpanContext,
  bindTracer,
  injectTraceparent,
  resolveTracer,
  tracedStorage,
  withSpan,
  type SpanContext,
  type TakibiTracer,
} from "./tracing";
import type { CollectionsDef } from "./types";

export type {
  CollectionsOptions,
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  HandleOptions,
  HandleResult,
  TakibiBrand,
  TakibiHandler,
} from "./context-types";

/**
 * Bind typed initial context (`handle(..., { context })` deps), then call the
 * returned factory with `{ resolve, stub? }`. Execution context is inferred
 * from `resolve`'s return type.
 */
export function createTakibi<TInitial = Record<string, never>>(): CreateContextFn<TInitial> {
  return ((config) =>
    buildContext(config as ContextConfig<object, TInitial>)) as CreateContextFn<TInitial>;
}

function buildContext<TInitial>(
  config: ContextConfig<object, TInitial>,
): CreateContextBuilder<object, TInitial> {
  const { resolve, stub: resolveStub } = config;
  const defaults = mergeLoggingOptions({}, config);

  return {
    policy: createPolicyHelper(),
    defineCollection: defineCollectionValue,
    defineCollections(collections, options: InternalCollectionsOptions = {}) {
      if (typeof collections !== "object" || collections === null) {
        throw new TakibiError("INVALID_COLLECTION", "Collections must be an object", 500);
      }
      const prototype = Object.getPrototypeOf(collections);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TakibiError("INVALID_COLLECTION", "Collections must be a plain object", 500);
      }
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
        const definition = descriptor.value as CollectionsDef<object>[string];
        assertCollectionName(propertyKey);
        assertNoActionsOption(definition);
        assertCollectionMigrations(definition, propertyKey);
      }
      return createAppDefinition({
        collections: collections as CollectionsDef<object>,
        resolve,
        resolveStub,
        options: { ...defaults, ...options },
      }) as never;
    },
  };
}

function createAppDefinition<TInitial>(args: {
  collections: CollectionsDef<object>;
  resolve: ContextResolver<object, TInitial>;
  resolveStub?: ContextStubResolver<object, TInitial>;
  options: InternalCollectionsOptions;
}): AppDefinition<object, CollectionsDef<object>, TInitial> {
  const { collections, resolve, resolveStub, options } = args;
  const collectionNames = new Set(Object.keys(collections));
  let assembled = false;

  const app = Object.create(null) as Record<string, unknown>;
  for (const name of collectionNames) {
    app[name] = {
      actions(define: (defineAction: () => unknown) => ActionDefinitions) {
        return define(() => createDocumentActionBuilder(name));
      },
    };
  }
  app.defineAction = () => createRootActionBuilder();
  app.actions = (map: ActionScopeMap) => {
    if (assembled) {
      throw new TakibiError("INVALID_ACTION", "app.actions() can only be called once", 500);
    }
    if (typeof map !== "object" || map === null) {
      throw new TakibiError("INVALID_ACTION", "Action scope map must be an object", 500);
    }
    const mapPrototype = Object.getPrototypeOf(map);
    if (mapPrototype !== Object.prototype && mapPrototype !== null) {
      throw new TakibiError("INVALID_ACTION", "Action scope map must be a plain object", 500);
    }
    const registry = new ActionRegistry();
    for (const scopeKey of Reflect.ownKeys(map)) {
      if (typeof scopeKey !== "string") {
        throw new TakibiError("INVALID_ACTION", "Action scopes must be strings", 500);
      }
      const descriptor = Object.getOwnPropertyDescriptor(map, scopeKey);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TakibiError(
          "INVALID_ACTION",
          `Action scopes must be enumerable data properties: ${scopeKey}`,
          500,
        );
      }
      const definitions = descriptor.value as ActionDefinitions;
      if (scopeKey === "$") {
        registry.registerRootActions(definitions, collectionNames);
      } else if (collectionNames.has(scopeKey)) {
        registry.registerCollectionActions(scopeKey, definitions);
      } else {
        throw new TakibiError("INVALID_ACTION", `Unknown action scope: ${scopeKey}`, 500);
      }
    }
    assembled = true;
    return assembleHandler({
      collections,
      registry,
      actionMap: map,
      resolve,
      resolveStub,
      options,
    });
  };
  return app as unknown as AppDefinition<object, CollectionsDef<object>, TInitial>;
}

function assembleHandler<TInitial, TCollections extends CollectionsDef<object>>(args: {
  collections: TCollections;
  registry: ActionRegistry;
  actionMap: ActionScopeMap;
  resolve: ContextResolver<object, TInitial>;
  resolveStub?: ContextStubResolver<object, TInitial>;
  options: InternalCollectionsOptions;
}): TakibiHandler<object, TCollections, TInitial> {
  const { collections, registry, actionMap, resolve, resolveStub, options } = args;
  const memory = options.memory ?? false;
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  const logger = resolveLogging(options);

  const memoryDriver = memory
    ? applyStorageLogging(
        createMigratingStorage(collections, createMemoryStorage(), logger),
        logger,
      )
    : null;
  const memoryReady = memoryDriver
    ? seedCollections(collections, memoryDriver, logger)
    : Promise.resolve();

  const run = async (
    request: Request,
    initial: unknown,
    invocation: PublicRequest,
    tracer: TakibiTracer | undefined,
  ): Promise<Response> => {
    try {
      await memoryReady;
      const input = { request, context: initial as TInitial };
      let resolveSpan: SpanContext | undefined;
      const ctx = await withLoggedSpan(
        logger,
        { name: TAKIBI_SPAN.resolve, kind: "internal" },
        { event: "takibi.resolve" },
        async () => {
          resolveSpan = activeSpanContext();
          const resolved = await resolve(input);
          assertSerializableContext(resolved);
          return resolved;
        },
      );

      if (memoryDriver) {
        const driver = tracer ? tracedStorage(memoryDriver) : memoryDriver;
        const data = await withLoggedSpan(
          logger,
          {
            name: TAKIBI_SPAN.executor,
            kind: "internal",
            attributes: invocationSpanAttributes(invocation),
          },
          { event: "takibi.executor", ...debugInvocationFields(invocation) },
          () =>
            invocation.kind === "action"
              ? executeAction(registry, collections, driver, ctx, invocation, logger)
              : executeOperation(collections, driver, ctx, invocation, logger),
          resolveSpan,
        );
        return Response.json({ ok: true, data } satisfies WireResponse);
      }

      if (!resolveStub) {
        throw new TakibiError(
          "MISSING_STUB",
          "Durable Object mode requires stub on createTakibi()({ stub }) — or use defineCollections(..., { memory: true }) for tests",
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

      const wire: WireRequest = { ...invocation, context: ctx };
      const json = await withLoggedSpan(
        logger,
        {
          name: TAKIBI_SPAN.wire,
          kind: "client",
          attributes: invocationSpanAttributes(invocation),
        },
        { event: "takibi.wire", ...debugInvocationFields(invocation) },
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
            throw new TakibiError(
              "INVALID_DO_RESPONSE",
              "Invalid response from Durable Object",
              500,
            );
          }
          return body;
        },
        resolveSpan,
      );
      return Response.json(json, { status: json.ok ? 200 : json.error.status });
    } catch (err) {
      return errorResponse(err, logger, invocation);
    }
  };

  const serveDecoded = async (
    request: Request,
    initial: unknown,
    decode: () => Promise<PublicRequest>,
  ): Promise<Response> => {
    const tracer = resolveTracer(options);
    const execute = () =>
      withSpan({ name: TAKIBI_SPAN.request, kind: "server" }, async () => {
        const startedAt = performance.now();
        let invocation: PublicRequest | undefined;
        let response: Response;
        try {
          invocation = await decode();
          logger?.emit({
            level: "info",
            event: "takibi.request",
            message: "started",
            ...invocationFields(invocation),
          });
          response = await run(request, initial, invocation, tracer);
        } catch (err) {
          response = errorResponse(err, logger, invocation);
        }
        logger?.emit({
          level: "info",
          event: "takibi.request",
          message: "completed",
          ...(invocation === undefined ? {} : invocationFields(invocation)),
          durationMs: performance.now() - startedAt,
          status: response.status,
        });
        return response;
      });
    return tracer ? bindTracer(tracer, execute) : execute();
  };

  // Routes read the trailing raw path segments: action ids are split on the
  // raw last colon before percent-decoding (Hono params decode too early).
  const mountPublicRoute = (path: string, segmentCount: number, extra = false) => {
    app.all(path, async (c) => {
      const response = await serveDecoded(c.req.raw, {}, () =>
        extra
          ? Promise.reject(new NotFoundError())
          : decodePublicRoute(
              c.req.method,
              rawPathSegments(new URL(c.req.url).pathname, segmentCount),
              new URL(c.req.url).searchParams,
              () => (c.req.raw.body === null ? Promise.resolve(undefined) : c.req.json()),
            ),
      );
      return c.newResponse(response.body, response);
    });
  };

  mountPublicRoute("/:collection", 1);
  mountPublicRoute("/:collection/:id", 2);
  mountPublicRoute("/:collection/:id/*", 0, true);
  app.all("/", async (c) => {
    const response = await serveDecoded(c.req.raw, {}, () => decodePublicHttp(c.req.raw));
    return c.newResponse(response.body, response);
  });

  const DurableObjectClass = createDurableObjectClass(collections, registry, options, logger);
  const handler = app as TakibiHandler<object, TCollections, TInitial>;
  Object.defineProperty(handler, "~takibi", {
    value: {
      context: null as unknown as object,
      initial: null as unknown as TInitial,
      collections,
      actions: actionMap,
    },
    enumerable: false,
  });
  handler.DurableObject = DurableObjectClass as typeof handler.DurableObject;
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
  handler.with = ((
    withOptions: LoggingOptions & {
      memory: true;
      resolve?: ContextResolver<object, TInitial>;
    },
  ) =>
    assembleHandler({
      collections,
      registry: registry.clone(),
      actionMap,
      resolve: withOptions.resolve ?? resolve,
      options: { ...mergeLoggingOptions(options, withOptions), memory: true },
    })) as typeof handler.with;
  return handler;
}
