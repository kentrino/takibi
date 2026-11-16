import { serveWatchUpgrade } from "../watch-upgrade";
import { TakibiError, type ActionRegistry, type CollectionsDef } from "@takibi/api";
import { assignTakibiBrand } from "../brand";
import { createDurableObjectClass } from "../durable-object";
import { emitFailure, resolveLogging, type InternalLogger } from "../logging";
import {
  registerTestingFork,
  type TestingExecutorFactory,
  type TestingForkOptions,
} from "../testing-bridge.server";
import { testingBackend, type BackendFactory } from "./backend";
import { createHttpHandler } from "./http-handler";
import { mergeLoggingOptions, normalizeInvocationFailureForServer } from "./runtime";
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

type ApplicationConfig<TCtx extends object, TInitial, TEnv, TServices> = {
  resolve: ContextResolver<TCtx, TInitial>;
  services?: ServicesFactory<TEnv, TServices>;
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
> {
  constructor(
    private readonly definition: ApplicationDefinition<TCollections, TActions>,
    private readonly config: ApplicationConfig<TCtx, TInitial, TEnv, TServices>,
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
      createHttpHandler<TInitial>((request, initial, decode) =>
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? serveWatchUpgrade({
              request,
              initial,
              decode,
              resolve,
              upgrade: backend.upgrade,
              logger,
            })
          : serveDecodedCall({
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
    if (backend.close) {
      const { dispose, asyncDispose } = disposalOf(backend.close, logger);
      Object.defineProperty(handler, Symbol.dispose, { value: dispose, enumerable: false });
      Object.defineProperty(handler, Symbol.asyncDispose, {
        value: asyncDispose,
        enumerable: false,
      });
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
    // mount installs the testing backend's non-enumerable disposal methods.
    return handler as typeof handler & Disposable & AsyncDisposable;
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

/**
 * Disposal of a backend whose `close()` rejects with a startup failure no
 * request reported. The first disposal called owns that report, so it is
 * reported exactly once and never dropped:
 *
 * - `Symbol.asyncDispose` first: its promise rejects with the failure (every
 *   further `Symbol.asyncDispose` returns that same promise); a later
 *   `Symbol.dispose` adds nothing.
 * - `Symbol.dispose` first: it cannot hand the failure to its caller and must
 *   not leave an unhandled rejection, so it emits a `takibi.error` event to
 *   the configured logger, or `console.error` when logging is off (no logger
 *   configured, or `logger: false`: turning logging off does not drop the
 *   report); a later `Symbol.asyncDispose` resolves once closing finished.
 */
function disposalOf(
  close: () => Promise<void>,
  logger: InternalLogger | undefined,
): { dispose: () => void; asyncDispose: () => Promise<void> } {
  let owner: "sync" | "async" | undefined;
  return {
    dispose: () => {
      if (owner !== undefined) return;
      owner = "sync";
      close().catch((error: unknown) => {
        if (logger) {
          emitFailure(logger, normalizeInvocationFailureForServer(error));
        } else {
          console.error("Takibi: startup failed and no request reported it", error);
        }
      });
    },
    asyncDispose: () => {
      if (owner === "sync") return close().catch(() => undefined);
      owner = "async";
      return close();
    },
  };
}
