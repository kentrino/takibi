import { TakibiError, type ActionRegistry, type CollectionsDef } from "@takibi/takibi-api";
import { assignTakibiBrand } from "../brand";
import { createDurableObjectClass } from "../durable-object";
import { resolveLogging } from "../logging";
import {
  registerTestingFork,
  type TestingExecutorFactory,
  type TestingForkOptions,
} from "../testing-bridge.server";
import { testingBackend, type BackendFactory } from "./backend";
import type { InitialHttpHandler, ServeCall } from "./http-handler";
import { mergeLoggingOptions } from "./runtime";
import { serveDecodedCall } from "./worker-call";
import type {
  ActionScopeMap,
  ContextResolver,
  InternalCollectionsOptions,
  ServicesFactory,
} from "./types";

type ApplicationDefinition<TCollections extends CollectionsDef, TActions extends ActionScopeMap> = {
  collections: TCollections;
  actions: TActions;
  registry: ActionRegistry;
};

type ApplicationConfig<TCtx extends object, TInitial, TEnv, TServices, THttp> = {
  resolve: ContextResolver<TCtx, TInitial>;
  services?: ServicesFactory<TEnv, TServices>;
  http: (serve: ServeCall<TInitial>) => THttp;
  options: InternalCollectionsOptions;
};

/** Validated definitions outlive backends; each mount owns its backend resources. */
export class Application<
  TCtx extends object,
  TInitial,
  TEnv,
  TServices,
  TCollections extends CollectionsDef<TCtx>,
  TActions extends ActionScopeMap,
  THttp extends InitialHttpHandler<TInitial>,
> {
  constructor(
    private readonly definition: ApplicationDefinition<TCollections, TActions>,
    private readonly config: ApplicationConfig<TCtx, TInitial, TEnv, TServices, THttp>,
  ) {}

  mount(createBackend: BackendFactory<TInitial, TCtx>) {
    const { collections, actions, registry } = this.definition;
    const { resolve, services, options } = this.config;
    const logger = resolveLogging(options);
    const DurableObject = createDurableObjectClass(
      collections,
      registry,
      options,
      logger,
      services,
    );
    const backend = createBackend({ collections, registry, logger });
    const http = Object.assign(
      this.config.http((request, initial, decode) =>
        serveDecodedCall({
          request,
          initial,
          decode,
          resolve,
          execute: backend.execute,
          logger,
          options,
        }),
      ),
      { DurableObject },
    );
    const handler = assignTakibiBrand<
      typeof http,
      TCollections,
      TActions,
      TCtx,
      TInitial,
      TServices
    >(http, { collections, actions });
    if (backend.dispose) {
      Object.defineProperty(handler, Symbol.dispose, { value: backend.dispose, enumerable: false });
    }
    registerTestingFork(handler, (options, createExecutor) =>
      this.fork(options).mountForTesting(createExecutor, options.services),
    );
    return handler;
  }

  private mountForTesting(createExecutor: TestingExecutorFactory, services: unknown) {
    const handler = this.mount(
      testingBackend(createExecutor, services === undefined ? {} : services),
    );
    // mount installs the testing backend's non-enumerable disposal method.
    return handler as typeof handler & Disposable;
  }

  private fork(options: TestingForkOptions<TCtx, TInitial, TServices>) {
    if (this.config.services && !("services" in options)) {
      throw new TakibiError(
        "MISSING_SERVICES",
        "SQLite test backend requires services when createTakibi()({ services }) is configured",
        500,
      );
    }
    return new Application(
      { ...this.definition, registry: this.definition.registry.clone() },
      {
        ...this.config,
        resolve: options.resolve ?? this.config.resolve,
        options: mergeLoggingOptions(this.config.options, options),
      },
    );
  }
}
