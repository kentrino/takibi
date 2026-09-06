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

export type TestingForkOptions = LoggingOptions & {
  resolve?: (input: { request: Request; context: unknown }) => object | Promise<object>;
  services?: unknown;
};

export type TestingExecutorFactory = (input: {
  collections: CollectionsDef<object>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
}) => {
  execute: Executor;
  dispose(): void;
};

export type TestingFork = (
  options: TestingForkOptions,
  createExecutor: TestingExecutorFactory,
) => unknown;

const TESTING_FORKS_SYMBOL = Symbol.for("takibi.testingForks");

function testingForks(): WeakMap<object, TestingFork> {
  const holder = globalThis as typeof globalThis & {
    [TESTING_FORKS_SYMBOL]?: WeakMap<object, TestingFork>;
  };
  holder[TESTING_FORKS_SYMBOL] ??= new WeakMap();
  return holder[TESTING_FORKS_SYMBOL];
}

export function registerTestingFork(handler: object, fork: TestingFork): void {
  testingForks().set(handler, fork);
}

export function getTestingFork(handler: object): TestingFork | undefined {
  return testingForks().get(handler);
}

/**
 * Assemble seed initialization, migrations, index reconciliation, logging
 * wrappers, and in-process execution around a supplied Durable Object storage
 * backend. Callers own the backend lifetime.
 */
export function createInProcessRuntime(input: {
  collections: CollectionsDef<object>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
  storage: DurableObjectStorage;
}): {
  execute: Executor;
  dispose(): void;
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
    dispose() {},
  };
}
