import { seedCollections } from "./durable-object";
import { compileIndexRegistry } from "./indexes";
import { reconcileCollectionIndexes } from "./index-reconcile";
import { createMigratingStorage } from "./migrations";
import { createDurableObjectStorage } from "./storage";
import { createInProcessExecutor } from "./context/executors";
import { applyStorageLogging } from "./context/runtime";
import {
  getTestingFork,
  type TestingExecutorFactory,
  type TestingForkOptions,
} from "./context/testing-fork.server";
import type { ActionScopeMap, ContextResolverInput, TakibiHandler } from "./context/types";
import type { LoggingOptions } from "./logging";
import { createSqliteDurableObjectStorage } from "./testing/sqlite-storage.server";

const storageFinalizer = new FinalizationRegistry<
  ReturnType<typeof createSqliteDurableObjectStorage>
>((storage) => storage.close());

type ServicesOption<TServices> = keyof TServices extends never
  ? { services?: TServices }
  : { services: TServices };

export type SqliteTestBackendOptions<TCtx extends object, TInitial, TServices> = LoggingOptions & {
  resolve?: (input: ContextResolverInput<TInitial>) => TCtx | Promise<TCtx>;
} & ServicesOption<TServices>;

const createSqliteExecutor: TestingExecutorFactory = ({
  collections,
  registry,
  logger,
  services,
}) => {
  const storage = createSqliteDurableObjectStorage();
  const indexRegistry = compileIndexRegistry(collections);
  const driver = applyStorageLogging(
    createMigratingStorage(collections, createDurableObjectStorage(storage, indexRegistry), logger),
    logger,
  );
  const ready = (async () => {
    await reconcileCollectionIndexes({
      sql: storage.sql,
      collections,
      storage: driver,
      registry: indexRegistry,
      logger,
    });
    await seedCollections(collections, driver, logger);
  })();
  const execute = createInProcessExecutor(collections, registry, logger, services, driver, ready);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    storageFinalizer.unregister(execute);
    storage.close();
  };
  storageFinalizer.register(execute, storage, execute);
  return { execute, dispose };
};

export function withSqliteTestBackend<
  TCtx extends object,
  TCollections,
  TInitial,
  TActionMap extends ActionScopeMap,
  TServices,
  TEnv,
>(
  handler: TakibiHandler<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv>,
  ...[options]: keyof TServices extends never
    ? [options?: SqliteTestBackendOptions<TCtx, TInitial, TServices>]
    : [options: SqliteTestBackendOptions<TCtx, TInitial, TServices>]
): TakibiHandler<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv> & {
  [Symbol.dispose](): void;
} {
  const fork = getTestingFork(handler);
  if (fork === undefined) {
    throw new TypeError("Expected a Takibi handler created by createTakibi()");
  }
  return fork(
    (options ?? {}) as unknown as TestingForkOptions,
    createSqliteExecutor,
  ) as TakibiHandler<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv> & {
    [Symbol.dispose](): void;
  };
}
