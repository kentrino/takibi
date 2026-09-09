import type { Hono } from "hono";
import type { TakibiBrandCarrier, TakibiBrandRecord, TAKIBI_BRAND } from "./brand";
import type { ContextResolver } from "./context/types";
import type { ActionRegistry, CollectionsDef } from "@takibi/takibi-api";
import {
  compileIndexRegistry,
  createDurableObjectStorage,
  reconcileCollectionIndexes,
} from "@takibi/takibi-storage";
import { initializeMaintenanceLayout } from "@takibi/takibi-snapshot";
import { createInProcessExecutor, type Executor } from "./context/executors";
import { applyStorageLogging } from "./context/runtime";
import { seedCollections } from "./durable-object";
import type { InternalLogger, LoggingOptions } from "./logging";
import { createMigratingStorage } from "./migrations";

export type TestingForkOptions<
  TCtx extends object = object,
  TInitial = unknown,
  TServices = unknown,
> = LoggingOptions & {
  resolve?: ContextResolver<TCtx, TInitial>;
  services?: TServices;
};

export type TestingExecutorFactory = <TCtx extends object>(input: {
  collections: CollectionsDef<TCtx>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
}) => {
  execute: Executor<unknown, TCtx>;
  dispose(): void;
};

export type TestingFork<
  TCtx extends object = object,
  TInitial = unknown,
  TServices = unknown,
  THandler = unknown,
> = (
  options: TestingForkOptions<TCtx, TInitial, TServices>,
  createExecutor: TestingExecutorFactory,
) => THandler;

type BrandedHandler = TakibiBrandCarrier<TakibiBrandRecord<object>>;
/** Forks recreate the standard handler surface, not user-added properties. */
export type TestingForkHandler<THandler extends BrandedHandler> = Pick<
  THandler,
  Extract<keyof THandler, typeof TAKIBI_BRAND | "handle" | "DurableObject">
> &
  (THandler extends Hono<{ Bindings: Record<string, unknown> }>
    ? Hono<{ Bindings: Record<string, unknown> }>
    : {}) &
  Disposable;

type ForkOf<THandler extends BrandedHandler, TResult = THandler & Disposable> = TestingFork<
  THandler[typeof TAKIBI_BRAND]["context"],
  THandler[typeof TAKIBI_BRAND]["initial"],
  THandler[typeof TAKIBI_BRAND]["services"],
  TResult
>;

const TESTING_FORKS_SYMBOL = Symbol.for("takibi.testingForks");

function testingForks(): WeakMap<object, unknown> {
  const holder = globalThis as typeof globalThis & {
    [TESTING_FORKS_SYMBOL]?: WeakMap<object, unknown>;
  };
  holder[TESTING_FORKS_SYMBOL] ??= new WeakMap();
  return holder[TESTING_FORKS_SYMBOL];
}

export function registerTestingFork<THandler extends BrandedHandler>(
  handler: THandler,
  fork: ForkOf<NoInfer<THandler>>,
): void {
  testingForks().set(handler, fork);
}

export function getTestingFork<THandler extends BrandedHandler>(
  handler: THandler,
): ForkOf<THandler, TestingForkHandler<THandler>> | undefined;
export function getTestingFork(handler: object): TestingFork | undefined;
export function getTestingFork(handler: object): unknown {
  // The heterogeneous registry restores the callback registered for this exact handler.
  return testingForks().get(handler);
}

/**
 * Assemble seed initialization, migrations, index reconciliation, logging
 * wrappers, and in-process execution around a supplied Durable Object storage
 * backend. Callers own the backend lifetime.
 */
export function createInProcessRuntime<TCtx extends object>(input: {
  collections: CollectionsDef<TCtx>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
  storage: DurableObjectStorage;
}): {
  execute: Executor<unknown, TCtx>;
} {
  const { collections, registry, logger, services, storage } = input;
  const indexRegistry = compileIndexRegistry(collections);
  const rawStorage = createDurableObjectStorage(storage, indexRegistry);
  initializeMaintenanceLayout(storage.sql);
  const driver = applyStorageLogging(
    createMigratingStorage(collections, rawStorage, logger),
    logger,
  );
  const ready = (async () => {
    await reconcileCollectionIndexes({
      sql: storage.sql,
      collections,
      storage: driver,
      registry: indexRegistry,
    });
    await seedCollections(collections, driver, logger);
  })();
  return {
    execute: createInProcessExecutor(collections, registry, logger, services, driver, ready),
  };
}
