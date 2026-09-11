import {
  INVOCATION_PREPARE_ADAPTER_KEYS,
  type ActionHandlerCtor,
  type AdapterMap,
  type InvocationAdapters,
} from "@takibi/worker-runtime-contract";
import { alias, defineContainer, inject, type DependencyGraph } from "tatenuki";
import { normalizeInvocationFailureForServer } from "./context/runtime";
import {
  createTakibiInvocationPlan,
  getTakibiRawInput,
  snapshotTakibiObserverEvent,
  toTakibiInvocation,
} from "./invocation-adapters";
import {
  createActionHandler,
  PolicyEvaluator,
  tracePolicyEvaluator,
} from "./invocation-collaborators";
import { InvocationPrepareApply } from "./invocation-prepare-apply";
import { SchemaParser, traceSchemaParser } from "./schema";
import type { TakibiInvocationRuntime, TakibiInvocationTypeMap } from "./invocation-type-map";

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;

/**
 * Contract `AdapterMap` pinned to Takibi's invocation type map.
 */
export type TakibiAdapterMap<TContext extends object, TServices = unknown> = AdapterMap<
  TakibiMap<TContext, TServices>
> & {
  invocationPrepareApply: InvocationPrepareApply<TContext, TServices>;
};

/**
 * Invocation registration without `invocationRun`. Production adds the runner
 * and its span on `resolveLocalAdapterMap`; this helper does not.
 */
export type TakibiInvocationRegistrationMap<
  TContext extends object = object,
  TServices = unknown,
> = Omit<TakibiAdapterMap<TContext, TServices>, "invocationRun">;

/**
 * Concrete adapter, default, and transaction wiring. Production and the
 * bound helper resolve this graph with `createTakibiInvocationAdapterFactories`.
 * Policy / schema / handler spans are created here; `invocationRun` tracing
 * and notify stay off this graph so they are not doubled.
 */
export const TAKIBI_INVOCATION_REGISTRATION_GRAPH = {
  invocationRuntime: [],
  invocationToInvocation: [],
  invocationGetRawInput: [],
  invocationCreatePlan: [],
  invocationPolicy: ["invocationRuntime"],
  invocationSchema: ["invocationRuntime"],
  invocationActionHandler: ["invocationRuntime"],
  invocationPrepareApply: [...INVOCATION_PREPARE_ADAPTER_KEYS],
  transactionNone: ["invocationPrepareApply"],
  transactionApply: ["invocationPrepareApply"],
  transactionFull: ["invocationPrepareApply"],
  transactionRun: ["invocationRuntime"],
  transactionClassifyFailure: [],
  invocationToFailure: [],
  invocationSnapshotObserverEvent: [],
  invocationNotify: [],
} as const satisfies DependencyGraph<TakibiInvocationRegistrationMap<object, unknown>>;

export function createTakibiInvocationAdapterFactories<
  TContext extends object,
  TServices = unknown,
>() {
  return {
    invocationToInvocation: () => toTakibiInvocation,
    invocationGetRawInput: () => getTakibiRawInput,
    invocationCreatePlan: () => createTakibiInvocationPlan,
    invocationPolicy: ({
      invocationRuntime,
    }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationRuntime">) =>
      tracePolicyEvaluator(new PolicyEvaluator(), invocationRuntime.logger),
    invocationSchema: ({
      invocationRuntime,
    }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationRuntime">) =>
      traceSchemaParser(new SchemaParser(), invocationRuntime.logger),
    invocationActionHandler:
      ({ invocationRuntime }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationRuntime">) =>
      (ctor: ActionHandlerCtor) =>
        createActionHandler({
          ...ctor,
          logger: ctor.logger ?? invocationRuntime.logger,
        }),
    invocationPrepareApply: inject(InvocationPrepareApply<TContext, TServices>),
    transactionNone: alias("invocationPrepareApply"),
    transactionApply: alias("invocationPrepareApply"),
    transactionFull: alias("invocationPrepareApply"),
    transactionRun:
      ({ invocationRuntime }: Pick<TakibiAdapterMap<TContext, TServices>, "invocationRuntime">) =>
      <TResult>(
        work: (storage: TakibiMap<TContext, TServices>["runtime"]["storage"]) => Promise<TResult>,
      ) =>
        invocationRuntime.storage.transaction(work),
    transactionClassifyFailure: () => undefined,
    invocationToFailure: () => normalizeInvocationFailureForServer,
    invocationSnapshotObserverEvent: () => snapshotTakibiObserverEvent,
    invocationNotify: () => undefined,
  };
}

export async function resolveTakibiInvocationRegistration<
  TContext extends object,
  TServices = unknown,
>(
  runtime: TakibiInvocationRuntime<TContext, TServices>,
  overrides?: Partial<TakibiInvocationRegistrationMap<TContext, TServices>>,
): Promise<TakibiInvocationRegistrationMap<TContext, TServices>> {
  type Map = TakibiInvocationRegistrationMap<TContext, TServices>;
  const builder = defineContainer<Map>()
    .graph(TAKIBI_INVOCATION_REGISTRATION_GRAPH)
    .factories(createTakibiInvocationAdapterFactories<TContext, TServices>());
  return (overrides === undefined ? builder : builder.override(overrides)).resolve({
    invocationRuntime: runtime,
  });
}

/**
 * Test and in-process entry over the same registration as production.
 * Resolves through tatenuki; it is async because that resolve is async.
 */
export async function createBoundInvocationAdapters<TContext extends object, TServices = unknown>(
  runtime: TakibiInvocationRuntime<TContext, TServices>,
  overrides?: Partial<TakibiInvocationRegistrationMap<TContext, TServices>>,
): Promise<InvocationAdapters<TakibiMap<TContext, TServices>>> {
  return resolveTakibiInvocationRegistration(runtime, overrides);
}
