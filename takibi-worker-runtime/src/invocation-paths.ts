import { createClass } from "@takibi/takibi-utility";
import { TakibiContractConfigurationError } from "@takibi/takibi-worker-runtime-contract";
import type {
  FullInvocationContract,
  InvocationExecutionView,
  InternalInvocationRuntime,
  InvocationAdapterResult,
  PrepareApplyInvocationContract,
} from "@takibi/takibi-worker-runtime-contract";
import type { JsonValue } from "@takibi/takibi-shared-types";
import type { StorageDriver } from "@takibi/takibi-storage";
import {
  authorizeIdentifiedAction,
  executeResolvedAction,
  identifyClassifiedAction,
  parseIdentifiedAction,
} from "./action-executor";
import { executeResolvedCollection, resolveCollection } from "./executor";
import { createActionHandler, createInvocationCollaborators } from "./invocation-collaborators";
import type {
  TakibiActionWork,
  TakibiApplyWork,
  TakibiInvocationTypeMap,
  TakibiNoneWork,
  TakibiPrepared,
} from "./invocation-type-map";

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;
type ExecutionView<TContext extends object, TServices> = InvocationExecutionView<
  TakibiMap<TContext, TServices>
>;

type TransactionBoundaryCtor<TContext extends object, TServices> = {
  readonly runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>;
};

function createPrepareApplyClass<
  TContext extends object,
  TServices,
  TWork extends TakibiNoneWork | TakibiApplyWork,
>(
  runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>,
): PrepareApplyInvocationContract<TakibiMap<TContext, TServices>, TWork, TakibiPrepared<TContext>> {
  const PrepareThenApply = createClass<
    PrepareApplyInvocationContract<TakibiMap<TContext, TServices>, TWork, TakibiPrepared<TContext>>
  >()
    .constructor<TransactionBoundaryCtor<TContext, TServices>>({ runtimeCheck: true })
    .define("prepare", (deps, state, work, storage) =>
      preparePlanned(deps.runtime, state, work, storage),
    )
    .define("apply", (_deps, state, prepared, storage) => applyPrepared(state, prepared, storage));

  return PrepareThenApply.new({ runtime });
}

function createPrepareAndApplyClass<TContext extends object, TServices>(
  runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>,
): FullInvocationContract<TakibiMap<TContext, TServices>, TakibiActionWork> {
  const PrepareAndApply = createClass<
    FullInvocationContract<TakibiMap<TContext, TServices>, TakibiActionWork>
  >()
    .constructor<TransactionBoundaryCtor<TContext, TServices>>({ runtimeCheck: true })
    .define("prepareAndApply", (deps, state, work, storage) =>
      prepareAndApplyPlanned(deps.runtime, state, work, storage),
    );

  return PrepareAndApply.new({ runtime });
}

export function createInvocationTransactionBoundaryContracts<TContext extends object, TServices>(
  runtime: InternalInvocationRuntime<TakibiInvocationTypeMap<TContext, TServices>>,
): {
  none: PrepareApplyInvocationContract<
    TakibiInvocationTypeMap<TContext, TServices>,
    TakibiNoneWork,
    TakibiPrepared<TContext>
  >;
  apply: PrepareApplyInvocationContract<
    TakibiInvocationTypeMap<TContext, TServices>,
    TakibiApplyWork,
    TakibiPrepared<TContext>
  >;
  full: FullInvocationContract<TakibiInvocationTypeMap<TContext, TServices>, TakibiActionWork>;
} {
  return {
    none: createPrepareApplyClass<TContext, TServices, TakibiNoneWork>(runtime),
    apply: createPrepareApplyClass<TContext, TServices, TakibiApplyWork>(runtime),
    full: createPrepareAndApplyClass(runtime),
  };
}

async function preparePlanned<TContext extends object, TServices>(
  runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>,
  state: ExecutionView<TContext, TServices>,
  work: TakibiNoneWork | TakibiApplyWork,
  storage: StorageDriver,
): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, TakibiPrepared<TContext>>> {
  if (work.kind === "action") {
    let context: TContext | undefined;
    try {
      const identified = await identifiedAction(runtime, state, work, storage);
      context = identified.context;
      const authorized = await authorizeIdentifiedAction<TContext, typeof identified>(
        identified,
        storage,
      );
      const resolved = await parseIdentifiedAction(authorized);
      const input = validatedActionInput<TContext, TServices>(resolved);
      return {
        outcome: "succeeded",
        value: { kind: "action", resolved },
        updates: { context, input },
      };
    } catch (error) {
      return {
        outcome: "failed",
        error,
        ...(context === undefined ? {} : { updates: { context } }),
      };
    }
  }
  try {
    const resolved = await resolveCollection({
      collections: runtime.collections,
      storage,
      ctx: state.context,
      req: work.request,
      logger: runtime.logger,
      policy: createInvocationCollaborators({
        logger: runtime.logger,
        collection: work.request.collection,
        operation: work.request.operation,
        documentId: work.request.id,
      }).policy,
    });
    return { outcome: "succeeded", value: { kind: "collection", resolved } };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

async function applyPrepared<TContext extends object, TServices>(
  state: ExecutionView<TContext, TServices>,
  prepared: TakibiPrepared<TContext>,
  storage: StorageDriver,
): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, JsonValue>> {
  if (prepared.kind === "action") {
    const resolved = { ...prepared.resolved, storage };
    try {
      const value = await executeResolvedAction(
        resolved,
        createActionHandler({
          logger: resolved.logger,
          definition: resolved.definition,
          actionName: resolved.invocation.name,
          actionScope: resolved.invocation.scope,
          documentId: resolved.invocation.id,
        }),
        state.plan.transactionBoundary !== "none",
      );
      return { outcome: "succeeded", value };
    } catch (error) {
      return { outcome: "failed", error };
    }
  }
  try {
    return {
      outcome: "succeeded",
      value: (await executeResolvedCollection({ ...prepared.resolved, storage })) as JsonValue,
    };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

async function prepareAndApplyPlanned<TContext extends object, TServices>(
  runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>,
  state: ExecutionView<TContext, TServices>,
  work: TakibiActionWork,
  storage: StorageDriver,
): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, JsonValue>> {
  const { definition } = work;
  if (definition.kind !== "collection" || definition.target !== "document" || !definition.atomic) {
    throw new TakibiContractConfigurationError(
      "full transaction boundary is only for document atomic actions",
    );
  }
  let context: TContext | undefined;
  try {
    const identified = await identifiedAction(runtime, state, work, storage);
    context = identified.context;
    const authorized = await authorizeIdentifiedAction<TContext, typeof identified>(
      identified,
      storage,
    );
    const resolved = await parseIdentifiedAction(authorized);
    const input = validatedActionInput<TContext, TServices>(resolved);
    const applied = await applyPrepared<TContext, TServices>(
      { ...state, context },
      { kind: "action", resolved },
      storage,
    );
    return {
      ...applied,
      updates: { context, input, ...applied.updates },
    };
  } catch (error) {
    return {
      outcome: "failed",
      error,
      ...(context === undefined ? {} : { updates: { context } }),
    };
  }
}

function validatedActionInput<TContext extends object, TServices>(resolved: {
  readonly definition: { readonly inputSchema?: unknown };
  readonly invocation: object;
  readonly input: TakibiMap<TContext, TServices>["input"];
}): import("@takibi/takibi-worker-runtime-contract").InvocationUpdates<
  TakibiMap<TContext, TServices>
>["input"] {
  return resolved.definition.inputSchema !== undefined ||
    Object.prototype.hasOwnProperty.call(resolved.invocation, "input")
    ? { status: "validated", value: resolved.input }
    : { status: "not-applicable" };
}

async function identifiedAction<TContext extends object, TServices>(
  runtime: InternalInvocationRuntime<TakibiMap<TContext, TServices>>,
  state: ExecutionView<TContext, TServices>,
  work: TakibiActionWork,
  storage: StorageDriver,
) {
  const { invocation, definition } = work;
  const collaborators = createInvocationCollaborators({
    logger: runtime.logger,
    actionName: invocation.name,
    actionScope: invocation.scope,
    documentId: invocation.id,
  });
  const identified = await identifyClassifiedAction({
    classified: { invocation, definition },
    collections: runtime.collections,
    storage,
    ctx: state.context,
    invocation,
    logger: runtime.logger,
    services: runtime.services,
    policy: collaborators.policy,
    schema: collaborators.schema,
  });
  return identified;
}
