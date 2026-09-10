import type { JsonValue } from "@takibi/takibi-shared-types";
import {
  composeActionPreparation,
  invocationStageResult,
  type InvocationExecutionView,
  type InvocationAdapterResult,
  type InvocationPrepareApplyDeps,
  type PrepareApplyInvocationContract,
} from "@takibi/takibi-worker-runtime-contract";
import type { StorageDriver } from "@takibi/takibi-storage";
import {
  authorizeIdentifiedAction,
  executeResolvedAction,
  identifyClassifiedAction,
  parseIdentifiedAction,
  type AuthorizedAction,
  type IdentifiedAction,
  type ResolvedAction,
} from "./action-resolution";
import { executeResolvedCollection, resolveCollection } from "./executor";
import {
  createActionHandler,
  createInvocationCollaborators,
  type ActionHandlerCtor,
  type ActionHandlerSurface,
  type PolicySurface,
  type SchemaSurface,
} from "./invocation-collaborators";
import type {
  TakibiActionWork,
  TakibiApplyWork,
  TakibiFullWork,
  TakibiInvocationTypeMap,
  TakibiNoneWork,
  TakibiPrepared,
} from "./invocation-type-map";

type TakibiMap<TContext extends object, TServices> = TakibiInvocationTypeMap<TContext, TServices>;
type PreparedAction<TContext extends object> = Extract<
  TakibiPrepared<TContext>,
  { kind: "action" }
>;
type ExecutionView<TContext extends object, TServices> = InvocationExecutionView<
  TakibiMap<TContext, TServices>
>;

export type { InvocationPrepareApplyDeps } from "@takibi/takibi-worker-runtime-contract";

/**
 * One prepare/apply implementation for none / apply / full. Direct
 * `executeAction` and top-level invocation both call this class.
 * Transaction selection and storage scope stay in contract `executePlan`.
 */
export class InvocationPrepareApply<
  TContext extends object,
  TServices = unknown,
> implements PrepareApplyInvocationContract<
  TakibiMap<TContext, TServices>,
  TakibiNoneWork | TakibiApplyWork | TakibiFullWork,
  TakibiPrepared<TContext>
> {
  readonly #policy: PolicySurface;
  readonly #schema: SchemaSurface;
  readonly #createActionHandler: (ctor: ActionHandlerCtor) => ActionHandlerSurface;

  constructor(deps: InvocationPrepareApplyDeps) {
    this.#policy = deps.invocationPolicy;
    this.#schema = deps.invocationSchema;
    this.#createActionHandler = deps.invocationActionHandler;
  }

  prepare(
    state: ExecutionView<TContext, TServices>,
    work: TakibiActionWork,
    storage: StorageDriver,
  ): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, PreparedAction<TContext>>>;
  prepare(
    state: ExecutionView<TContext, TServices>,
    work: TakibiNoneWork | TakibiApplyWork | TakibiFullWork,
    storage: StorageDriver,
  ): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, TakibiPrepared<TContext>>>;
  prepare(
    state: ExecutionView<TContext, TServices>,
    work: TakibiNoneWork | TakibiApplyWork | TakibiFullWork,
    storage: StorageDriver,
  ): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, TakibiPrepared<TContext>>> {
    if (work.kind === "action") {
      return prepareActionWork(state, work, storage, this.#policy, this.#schema);
    }
    return prepareCollectionWork(state, work, storage, this.#policy);
  }

  apply(
    state: ExecutionView<TContext, TServices>,
    prepared: PreparedAction<TContext>,
    storage: StorageDriver,
  ): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, JsonValue>>;
  apply(
    state: ExecutionView<TContext, TServices>,
    prepared: TakibiPrepared<TContext>,
    storage: StorageDriver,
  ): Promise<
    InvocationAdapterResult<
      TakibiMap<TContext, TServices>,
      TakibiMap<TContext, TServices>["result"]
    >
  >;
  apply(
    state: ExecutionView<TContext, TServices>,
    prepared: TakibiPrepared<TContext>,
    storage: StorageDriver,
  ): Promise<
    InvocationAdapterResult<
      TakibiMap<TContext, TServices>,
      TakibiMap<TContext, TServices>["result"]
    >
  > {
    return applyPrepared(state, prepared, storage, this.#createActionHandler);
  }
}

export function createInvocationPrepareApply<TContext extends object, TServices = unknown>(deps?: {
  logger?: TakibiMap<TContext, TServices>["runtime"]["logger"];
  invocationPolicy?: PolicySurface;
  invocationSchema?: SchemaSurface;
  invocationActionHandler?: (ctor: ActionHandlerCtor) => ActionHandlerSurface;
}): InvocationPrepareApply<TContext, TServices> {
  const collaborators = createInvocationCollaborators({ logger: deps?.logger });
  return new InvocationPrepareApply<TContext, TServices>({
    invocationPolicy: deps?.invocationPolicy ?? collaborators.policy,
    invocationSchema: deps?.invocationSchema ?? collaborators.schema,
    invocationActionHandler: deps?.invocationActionHandler ?? createActionHandler,
  });
}

async function prepareCollectionWork<TContext extends object, TServices>(
  state: ExecutionView<TContext, TServices>,
  work: Extract<TakibiNoneWork | TakibiApplyWork | TakibiFullWork, { kind: "collection" }>,
  storage: StorageDriver,
  policy: PolicySurface,
): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, TakibiPrepared<TContext>>> {
  return invocationStageResult(async () => {
    const resolved = await resolveCollection({
      collections: state.runtime.collections,
      storage,
      ctx: state.context,
      req: work.request,
      logger: state.runtime.logger,
      policy,
    });
    return { kind: "collection" as const, resolved };
  });
}

async function prepareActionWork<TContext extends object, TServices>(
  state: ExecutionView<TContext, TServices>,
  work: TakibiActionWork,
  storage: StorageDriver,
  policy: PolicySurface,
  schema: SchemaSurface,
): Promise<InvocationAdapterResult<TakibiMap<TContext, TServices>, PreparedAction<TContext>>> {
  const prepared = await composeActionPreparation<
    TakibiMap<TContext, TServices>,
    IdentifiedAction<TContext>,
    AuthorizedAction<TContext>,
    ResolvedAction<TContext>
  >({
    identify: () =>
      invocationStageResult(
        () => identifiedAction(state, work, storage, policy, schema),
        (identified) => ({ context: identified.context }),
      ),
    authorize: (identified) =>
      invocationStageResult(() =>
        authorizeIdentifiedAction<TContext, IdentifiedAction<TContext>>(identified, storage),
      ),
    parse: (authorized) =>
      invocationStageResult(
        () => parseIdentifiedAction(authorized),
        (resolved) => ({ input: validatedActionInput<TContext, TServices>(resolved) }),
      ),
  });
  if (prepared.outcome === "failed") return prepared;
  return {
    outcome: "succeeded",
    value: { kind: "action", resolved: prepared.value },
    updates: prepared.updates,
  };
}

async function applyPrepared<TContext extends object, TServices>(
  state: ExecutionView<TContext, TServices>,
  prepared: TakibiPrepared<TContext>,
  storage: StorageDriver,
  createHandler: (ctor: ActionHandlerCtor) => ActionHandlerSurface,
): Promise<
  InvocationAdapterResult<TakibiMap<TContext, TServices>, TakibiMap<TContext, TServices>["result"]>
> {
  if (prepared.kind === "action") {
    const resolved = { ...prepared.resolved, storage };
    return invocationStageResult(() =>
      executeResolvedAction(
        resolved,
        createHandler({
          logger: resolved.logger,
          definition: resolved.definition,
          actionName: resolved.invocation.name,
          actionScope: resolved.invocation.scope,
          documentId: resolved.invocation.id,
        }),
        state.plan.transactionBoundary !== "none",
      ),
    );
  }
  return invocationStageResult(() => executeResolvedCollection({ ...prepared.resolved, storage }));
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
  state: ExecutionView<TContext, TServices>,
  work: TakibiActionWork,
  storage: StorageDriver,
  policy: PolicySurface,
  schema: SchemaSurface,
) {
  return identifyClassifiedAction({
    classified: work,
    collections: state.runtime.collections,
    storage,
    ctx: state.context,
    logger: state.runtime.logger,
    services: state.runtime.services,
    policy,
    schema,
  });
}
