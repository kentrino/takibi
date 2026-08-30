import { Hono } from "hono";
import {
  ActionRegistry,
  assertCollectionName,
  assertNoActionsOption,
  createDocumentActionBuilder,
  createRootActionBuilder,
  defineCollection as defineCollectionValue,
  type ActionDefinitions,
} from "../action";
import {
  assertSerializableContext,
  errorResponse,
  invocationFields,
  mergeLoggingOptions,
} from "./runtime";
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
} from "./types";
import { createDurableObjectClass } from "../durable-object";
import { NotFoundError, TakibiError } from "../errors";
import {
  decodePublicHttp,
  decodePublicRoute,
  matchesPublicPrefix,
  rawPathSegments,
  readRequestJson,
  type PublicRequest,
} from "../http";
import { requestLogFields, resolveLogging, withLoggedSpan, type LoggingOptions } from "../logging";
import { assertCollectionMigrations } from "../migrations";
import { batchSpanAttributes, TAKIBI_SPAN } from "../otel-helper";
import { createPolicyHelper } from "../policy";
import {
  activeSpanContext,
  bindTracer,
  resolveTracer,
  withSpan,
  type SpanContext,
  type TakibiTracer,
} from "../tracing";
import type { CollectionsDef } from "../types";
import { assertCollectionUniqueConstraints } from "../unique";
import { createMemoryExecutor, createStubExecutor } from "./executors";
import { ownStringEntries } from "./own-entries";

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
} from "./types";

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
    defineCollection: defineCollectionValue as CreateContextBuilder<
      object,
      TInitial
    >["defineCollection"],
    defineCollections(collections, options: InternalCollectionsOptions = {}) {
      for (const [propertyKey, definition] of ownStringEntries(collections, "INVALID_COLLECTION", {
        subject: "Collections",
        keys: "Collection names",
      })) {
        assertCollectionName(propertyKey);
        assertNoActionsOption(definition as CollectionsDef<object>[string]);
        assertCollectionMigrations(definition as CollectionsDef<object>[string], propertyKey);
        assertCollectionUniqueConstraints(
          definition as CollectionsDef<object>[string],
          propertyKey,
        );
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
    const registry = new ActionRegistry();
    for (const [scopeKey, definitions] of ownStringEntries(map, "INVALID_ACTION", {
      subject: "Action scope map",
      keys: "Action scopes",
    })) {
      if (scopeKey === "$") {
        registry.registerRootActions(definitions as ActionDefinitions, collectionNames);
      } else if (collectionNames.has(scopeKey)) {
        registry.registerCollectionActions(scopeKey, definitions as ActionDefinitions);
      } else {
        throw new TakibiError("INVALID_ACTION", `Unknown action scope: ${scopeKey}`, 500);
      }
    }
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

  const execute = memory
    ? createMemoryExecutor(collections, registry, logger)
    : createStubExecutor(resolveStub, logger);

  const run = async (
    request: Request,
    initial: unknown,
    invocation: PublicRequest,
    tracer: TakibiTracer | undefined,
  ): Promise<Response> => {
    try {
      let resolveSpan: SpanContext | undefined;
      const batchSize = invocation.kind === "batch" ? invocation.items.length : undefined;
      const ctx = await withLoggedSpan(
        logger,
        {
          name: TAKIBI_SPAN.resolve,
          kind: "internal",
          ...(batchSize === undefined ? {} : { attributes: batchSpanAttributes(batchSize) }),
        },
        {
          event: "takibi.resolve",
          ...(batchSize === undefined ? {} : { batchSize }),
        },
        async () => {
          resolveSpan = activeSpanContext();
          const resolved = await resolve({ request, context: initial as TInitial });
          assertSerializableContext(resolved);
          return resolved;
        },
      );
      const json = await execute({ request, initial, ctx, invocation, tracer, resolveSpan });
      return Response.json(json, { status: json.ok ? 200 : json.error.status });
    } catch (err) {
      return errorResponse(err, logger, invocation, request);
    }
  };

  const serveDecoded = async (
    request: Request,
    initial: unknown,
    decode: () => Promise<PublicRequest>,
  ): Promise<Response> => {
    const tracer = resolveTracer(options);
    const serve = () =>
      withSpan({ name: TAKIBI_SPAN.request, kind: "server" }, async () => {
        const startedAt = performance.now();
        const http = requestLogFields(request);
        let invocation: PublicRequest | undefined;
        let response: Response;
        try {
          invocation = await decode();
          logger?.emit({
            level: "info",
            event: "takibi.request",
            message: "started",
            ...http,
            ...invocationFields(invocation),
          });
          response = await run(request, initial, invocation, tracer);
        } catch (err) {
          response = errorResponse(err, logger, invocation, request);
        }
        logger?.emit({
          level: "info",
          event: "takibi.request",
          message: "completed",
          ...http,
          ...(invocation === undefined ? {} : invocationFields(invocation)),
          durationMs: performance.now() - startedAt,
          status: response.status,
        });
        return response;
      });
    return tracer ? bindTracer(tracer, serve) : serve();
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
              () => readRequestJson(c.req.raw),
            ),
      );
      return c.newResponse(response.body, response);
    });
  };

  mountPublicRoute("/_batch", 1);
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
