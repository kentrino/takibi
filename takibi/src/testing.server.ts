import {
  createInProcessRuntime,
  getTestingFork,
  type TestingExecutorFactory,
  type TestingForkOptions,
} from "@takibi/takibi-worker-runtime/testing-bridge";
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
  const runtime = createInProcessRuntime({
    collections,
    registry,
    logger,
    services,
    storage,
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    storageFinalizer.unregister(runtime.execute);
    runtime.dispose();
    storage.close();
  };
  storageFinalizer.register(runtime.execute, storage, runtime.execute);
  return { execute: runtime.execute, dispose };
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
