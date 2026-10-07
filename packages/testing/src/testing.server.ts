import {
  createInProcessRuntime,
  getTestingFork,
  type TestingExecutorFactory,
  type TestingForkHandler,
} from "@takibi/worker-runtime/testing-bridge";
import type {
  ContextResolverInput,
  LoggingOptions,
  TakibiBrandCarrier,
  TakibiBrandRecord,
  TAKIBI_BRAND,
} from "@takibi/worker-runtime";
import { createSqliteDurableObjectStorage } from "./sqlite-storage.server";

const storageFinalizer = new FinalizationRegistry<
  ReturnType<typeof createSqliteDurableObjectStorage>
>((storage) => storage.close());

type ServicesOption<TServices> = keyof TServices extends never
  ? { services?: TServices }
  : { services: TServices };

export type SqliteTestBackendOptions<TCtx extends object, TInitial, TServices> = LoggingOptions & {
  resolve?: (input: ContextResolverInput<TInitial>) => TCtx | Promise<TCtx>;
} & ServicesOption<TServices>;

type ReplacementResolverOptions<TCtx extends object, TInitial, TServices> = LoggingOptions & {
  resolve: (input: ContextResolverInput<TInitial>) => TCtx | Promise<TCtx>;
} & ServicesOption<TServices>;

type ProductionResolverOptions<TServices> = LoggingOptions & {
  resolve?: never;
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
    storage.close();
  };
  storageFinalizer.register(runtime.execute, storage, runtime.execute);
  return { execute: runtime.execute, dispose };
};

export function withSqliteTestBackend<
  THandler extends TakibiBrandCarrier<TakibiBrandRecord<object>>,
  TInitial = Record<never, never>,
>(
  handler: THandler,
  options: ReplacementResolverOptions<
    THandler[typeof TAKIBI_BRAND]["context"],
    TInitial,
    THandler[typeof TAKIBI_BRAND]["services"]
  >,
): TestingForkHandler<THandler, TInitial>;
export function withSqliteTestBackend<
  THandler extends TakibiBrandCarrier<TakibiBrandRecord<object>>,
>(
  handler: THandler,
  ...[options]: keyof THandler[typeof TAKIBI_BRAND]["services"] extends never
    ? [options?: ProductionResolverOptions<THandler[typeof TAKIBI_BRAND]["services"]>]
    : [options: ProductionResolverOptions<THandler[typeof TAKIBI_BRAND]["services"]>]
): TestingForkHandler<THandler>;
export function withSqliteTestBackend<
  THandler extends TakibiBrandCarrier<TakibiBrandRecord<object>>,
  TInitial = THandler[typeof TAKIBI_BRAND]["initial"],
>(
  handler: THandler,
  options: SqliteTestBackendOptions<
    THandler[typeof TAKIBI_BRAND]["context"],
    TInitial,
    THandler[typeof TAKIBI_BRAND]["services"]
  >,
): TestingForkHandler<THandler, TInitial & THandler[typeof TAKIBI_BRAND]["initial"]>;
export function withSqliteTestBackend<
  THandler extends TakibiBrandCarrier<TakibiBrandRecord<object>>,
>(
  handler: THandler,
  options?: SqliteTestBackendOptions<
    THandler[typeof TAKIBI_BRAND]["context"],
    never,
    THandler[typeof TAKIBI_BRAND]["services"]
  >,
): TestingForkHandler<THandler, never> {
  const fork = getTestingFork(handler);
  if (fork === undefined) {
    throw new TypeError("Expected a Takibi handler created by createTakibi()");
  }
  return fork(options ?? {}, createSqliteExecutor);
}
