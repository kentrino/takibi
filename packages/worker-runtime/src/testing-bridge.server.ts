import type { TakibiBrandCarrier, TakibiBrandRecord, TAKIBI_BRAND } from "./brand";
import type { ContextResolver, HandleOptions } from "./context/types";
import type { ActionRegistry, CollectionsDef } from "@takibi/api";
import type { SqlExecutor } from "@takibi/storage";
import type { Executor } from "./context/executors";
import type { InternalLogger, LoggingOptions } from "./logging";
import { createTenantRuntime, type TenantHost } from "./tenant-runtime";

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
export type TestingForkHandler<
  THandler extends BrandedHandler,
  TInitial = THandler[typeof TAKIBI_BRAND]["initial"],
> = Pick<THandler, Extract<keyof THandler, "DurableObject">> & {
  readonly [TAKIBI_BRAND]: TakibiBrandRecord<
    THandler[typeof TAKIBI_BRAND]["context"],
    TInitial,
    THandler[typeof TAKIBI_BRAND]["collections"],
    THandler[typeof TAKIBI_BRAND]["actions"],
    THandler[typeof TAKIBI_BRAND]["services"]
  >;
} & (THandler extends { handle(request: infer TRequest, options: unknown): infer TResult }
    ? { handle(request: TRequest, options: HandleOptions<TInitial>): TResult }
    : {}) &
  Disposable;

type ForkOf<THandler extends BrandedHandler> = <TInitial>(
  options: TestingForkOptions<
    THandler[typeof TAKIBI_BRAND]["context"],
    TInitial,
    THandler[typeof TAKIBI_BRAND]["services"]
  >,
  createExecutor: TestingExecutorFactory,
) => TestingForkHandler<THandler, TInitial>;

type RegisteredTestingFork<THandler extends BrandedHandler> = TestingFork<
  THandler[typeof TAKIBI_BRAND]["context"],
  THandler[typeof TAKIBI_BRAND]["initial"],
  THandler[typeof TAKIBI_BRAND]["services"],
  TestingForkHandler<THandler>
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
  fork: RegisteredTestingFork<NoInfer<THandler>>,
): void {
  testingForks().set(handler, fork);
}

export function getTestingFork<THandler extends BrandedHandler>(
  handler: THandler,
): ForkOf<THandler> | undefined;
export function getTestingFork(handler: object): TestingFork | undefined;
export function getTestingFork(handler: object): unknown {
  // The heterogeneous registry restores the callback registered for this exact handler.
  return testingForks().get(handler);
}

/**
 * In-process host: startup runs immediately (requests await `ready`), and
 * there is no watch. Startup is async, so a runtime disposed before its first
 * request must not leak an unhandled rejection; every execution awaits `ready`
 * and reports its failure.
 */
const inProcessHost: TenantHost = {
  runStartup(startup) {
    const ready = startup();
    ready.catch(() => undefined);
    return ready;
  },
};

/**
 * The tenant runtime over a supplied SQL executor, executing invocations in
 * process. Callers own the executor lifetime.
 */
export function createInProcessRuntime<TCtx extends object>(input: {
  collections: CollectionsDef<TCtx>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
  sql: SqlExecutor;
}): {
  execute: Executor<unknown, TCtx>;
} {
  const runtime = createTenantRuntime({ ...input, host: inProcessHost });
  return {
    execute: ({ request, ctx, invocation, tracer, resolveSpan }) =>
      runtime.execute(
        { request, traced: !!tracer, spanKind: "internal", parentSpan: resolveSpan },
        (local) =>
          invocation.kind === "batch"
            ? local.executeBatch(ctx, invocation.items)
            : local.execute(ctx, invocation),
      ),
  };
}
