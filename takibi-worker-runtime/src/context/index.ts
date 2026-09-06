import {
  ActionRegistry,
  assertCollectionName,
  assertNoActionsOption,
  createDocumentActionBuilder,
  createRootActionBuilder,
  defineCollection as defineCollectionValue,
  NotFoundError,
  TakibiError,
  type ActionDefinitions,
  type CollectionsDef,
} from "@takibi/takibi-api";
import { createPolicyHelper } from "@takibi/takibi-policy";
import { Hono } from "hono";
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
import {
  decodePublicHttp,
  decodePublicRoute,
  matchesPublicPrefix,
  rawPathSegments,
  readRequestJson,
  type PublicRequest,
} from "../http";
import { requestLogFields, resolveLogging, withLoggedSpan } from "../logging";
import { assertCollectionMigrations } from "../migrations";
import { batchSpanAttributes, TAKIBI_SPAN } from "../otel-helper";
import {
  activeSpanContext,
  bindTracer,
  resolveTracer,
  withSpan,
  type SpanContext,
  type TakibiTracer,
} from "../tracing";
import { assertCollectionIndexes } from "@takibi/takibi-storage";
import { assertCollectionUniqueConstraints } from "../unique";
import { createStubExecutor } from "./executors";
import { ownStringEntries } from "./own-entries";
import {
  registerTestingFork,
  type TestingExecutorFactory,
  type TestingFork,
  type TestingForkOptions,
} from "../testing-bridge.server";

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
 * returned factory with `{ resolve, stub?, services? }`. Execution context is
 * inferred from `resolve`'s return type; `services` from its factory return.
 */
export function createTakibi<TInitial = Record<string, never>, TEnv = unknown>(): CreateContextFn<
  TInitial,
  TEnv
> {
  return ((config: ContextConfig<object, TInitial, TEnv>) =>
    buildContext(config)) as CreateContextFn<TInitial, TEnv>;
}

function buildContext<TInitial, TEnv>(
  config: ContextConfig<object, TInitial, TEnv>,
): CreateContextBuilder<object, TInitial> {
  const { resolve, stub: resolveStub, services: createServices } = config;
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
        assertCollectionIndexes(definition as CollectionsDef<object>[string], propertyKey);
      }
      return createAppDefinition({
        collections: collections as CollectionsDef<object>,
        resolve,
        resolveStub,
        createServices: createServices as ((input: { env: unknown }) => unknown) | undefined,
        options: { ...defaults, ...options },
      }) as never;
    },
  };
}

function createAppDefinition<TInitial>(args: {
  collections: CollectionsDef<object>;
  resolve: ContextResolver<object, TInitial>;
  resolveStub?: ContextStubResolver<object, TInitial>;
  createServices?: (input: { env: unknown }) => unknown;
  options: InternalCollectionsOptions;
}): AppDefinition<object, CollectionsDef<object>, TInitial> {
  const { collections, resolve, resolveStub, createServices, options } = args;
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
      createServices,
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
  createServices?: (input: { env: unknown }) => unknown;
  options: InternalCollectionsOptions;
  testing?: {
    createExecutor: TestingExecutorFactory;
    services: unknown;
  };
}): TakibiHandler<object, TCollections, TInitial> {
  const {
    collections,
    registry,
    actionMap,
    resolve,
    resolveStub,
    createServices,
    options,
    testing,
  } = args;
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  const logger = resolveLogging(options);

  const testingExecutor = testing?.createExecutor({
    collections,
    registry,
    logger,
    services: testing.services,
  });
  const execute = testingExecutor?.execute ?? createStubExecutor(resolveStub, logger);

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

  const DurableObjectClass = createDurableObjectClass(
    collections,
    registry,
    options,
    logger,
    createServices,
  );
  const handler = app as TakibiHandler<object, TCollections, TInitial>;
  Object.defineProperty(handler, "~takibi", {
    value: {
      context: null as unknown as object,
      initial: null as unknown as TInitial,
      collections,
      actions: actionMap,
      services: null,
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
  if (testingExecutor !== undefined) {
    Object.defineProperty(handler, Symbol.dispose, {
      value: () => testingExecutor.dispose(),
      enumerable: false,
    });
  }
  registerTestingFork(handler, ((
    withOptions: TestingForkOptions,
    createExecutor: TestingExecutorFactory,
  ) => {
    if (createServices != null && !("services" in withOptions)) {
      throw new TakibiError(
        "MISSING_SERVICES",
        "SQLite test backend requires services when createTakibi()({ services }) is configured",
        500,
      );
    }
    return assembleHandler({
      collections,
      registry: registry.clone(),
      actionMap,
      resolve: (withOptions.resolve ?? resolve) as ContextResolver<object, TInitial>,
      createServices,
      options: mergeLoggingOptions(options, withOptions) as InternalCollectionsOptions,
      testing: {
        createExecutor,
        services:
          "services" in withOptions && withOptions.services !== undefined
            ? withOptions.services
            : {},
      },
    });
  }) satisfies TestingFork);
  return handler;
}
