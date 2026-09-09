import { TakibiError, type ActionRegistry, type CollectionsDef } from "@takibi/takibi-api";
import { assignTakibiBrand } from "../brand";
import { createDurableObjectClass } from "../durable-object";
import { resolveLogging } from "../logging";
import { registerTestingFork, type TestingForkOptions } from "../testing-bridge.server";
import { testingBackend, type BackendFactory } from "./backend";
import { createHttpHandler } from "./http-handler";
import { mergeLoggingOptions } from "./runtime";
import { serveDecodedCall } from "./worker-call";
import type {
  ActionScopeMap,
  ContextResolver,
  InternalCollectionsOptions,
  ServicesFactory,
} from "./types";

type ApplicationDefinition = {
  collections: CollectionsDef<object>;
  actions: ActionScopeMap;
  registry: ActionRegistry;
};

type ApplicationConfig = {
  resolve: ContextResolver<object, unknown>;
  services?: ServicesFactory<unknown, unknown>;
  options: InternalCollectionsOptions;
};

/** Validated definitions outlive backends; each mount owns its backend resources. */
export class Application {
  constructor(
    private readonly definition: ApplicationDefinition,
    private readonly config: ApplicationConfig,
  ) {}

  mount(createBackend: BackendFactory) {
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
    const handler = assignTakibiBrand(
      Object.assign(
        createHttpHandler((request, initial, decode) =>
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
      ),
      { collections, actions },
    );
    if (backend.dispose) {
      Object.defineProperty(handler, Symbol.dispose, { value: backend.dispose, enumerable: false });
    }
    registerTestingFork(handler, (options, createExecutor) =>
      this.fork(options).mount(
        testingBackend(createExecutor, options.services === undefined ? {} : options.services),
      ),
    );
    return handler;
  }

  private fork(options: TestingForkOptions): Application {
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
