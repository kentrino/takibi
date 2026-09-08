import {
  ActionRegistry,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  type ActionGateContext,
  type ActionGuardFn,
  type CollectionsDef,
  type RuntimeActionDefinition,
} from "@takibi/takibi-api";
import type { JsonValue } from "@takibi/takibi-shared-types";
import { allows, denialReasonOf, type AccessGrant } from "@takibi/takibi-policy";
import { createPolicyCollections, createTrustedCollections } from "./executor";
import {
  type ActionHandlerSurface,
  type PolicySurface,
  type SchemaSurface,
} from "./invocation-collaborators";
import type { InternalLogger } from "./logging";
import type { StorageDriver } from "@takibi/takibi-storage";
import type { ActionInvocation } from "./action-gate";

export type ClassifiedAction = {
  readonly invocation: ActionInvocation;
  readonly definition: RuntimeActionDefinition;
};

export type IdentifiedAction<TCtx extends object> = {
  readonly invocation: ActionInvocation;
  readonly context: TCtx;
  readonly definition: RuntimeActionDefinition;
  readonly rawInput: unknown;
  readonly collections: CollectionsDef<TCtx>;
  readonly storage: StorageDriver;
  readonly logger?: InternalLogger;
  readonly services: unknown;
  readonly policy: PolicySurface;
  readonly schema: SchemaSurface;
};

export type AuthorizedAction<TCtx extends object> = IdentifiedAction<TCtx> & {
  readonly grant: AccessGrant;
  readonly document?: unknown;
};

export type ResolvedAction<TCtx extends object> = AuthorizedAction<TCtx> & {
  readonly input: unknown;
};

export function classifyAction(
  registry: ActionRegistry,
  invocation: ActionInvocation,
): ClassifiedAction {
  const registered = registry.get(invocation.scope, invocation.name);
  if (!registered) {
    throw new NotFoundError(`Unknown action: ${invocation.name}`);
  }
  validateActionInvocation(registered.definition, invocation);
  return { invocation, definition: registered.definition };
}

export async function identifyAction<TCtx extends object>(args: {
  registry: ActionRegistry;
  collections: CollectionsDef<TCtx>;
  storage: StorageDriver;
  ctx: TCtx;
  invocation: ActionInvocation;
  logger?: InternalLogger;
  services?: unknown;
  policy: PolicySurface;
  schema: SchemaSurface;
}): Promise<IdentifiedAction<TCtx>> {
  return identifyClassifiedAction({
    ...args,
    classified: classifyAction(args.registry, args.invocation),
  });
}

export async function identifyClassifiedAction<TCtx extends object>(args: {
  classified: ClassifiedAction;
  collections: CollectionsDef<TCtx>;
  storage: StorageDriver;
  ctx: TCtx;
  invocation: ActionInvocation;
  logger?: InternalLogger;
  services?: unknown;
  policy: PolicySurface;
  schema: SchemaSurface;
}): Promise<IdentifiedAction<TCtx>> {
  const { classified, collections, storage, ctx, invocation, logger, policy, schema } = args;
  const services = args.services ?? {};
  const { definition } = classified;

  // Guards run before document load and gate evaluation so auth failures do
  // not reveal whether a target id exists.
  const actionCtx = (await applyGuards(definition.guards, ctx)) as TCtx;

  return {
    invocation,
    context: actionCtx,
    definition,
    rawInput: invocation.input,
    collections,
    storage,
    logger,
    services,
    policy,
    schema,
  };
}

function validateActionInvocation(
  definition: RuntimeActionDefinition,
  invocation: ActionInvocation,
): void {
  const isDocument = definition.kind === "collection" && definition.target === "document";
  const hasId = Object.prototype.hasOwnProperty.call(invocation, "id");
  if (isDocument) {
    if (typeof invocation.id !== "string" || invocation.id === "") {
      throw new BadRequestError(`Document action requires an id: ${invocation.name}`);
    }
  } else if (hasId) {
    throw new BadRequestError(`Action does not take a document id: ${invocation.name}`);
  }
}

export async function authorizeIdentifiedAction<
  TCtx extends object,
  T extends IdentifiedAction<TCtx>,
>(identified: T, storage: StorageDriver): Promise<T & AuthorizedAction<TCtx>> {
  const { invocation, context, definition, policy } = identified;
  const isDocument = definition.kind === "collection" && definition.target === "document";
  if (isDocument) {
    const id = invocation.id!;
    if (!identified.collections[invocation.scope]) {
      throw new NotFoundError(`Unknown collection: ${invocation.scope}`);
    }
    const doc = await storage.get(invocation.scope, id);
    if (!doc) throw new NotFoundError(`Document not found: ${id}`);
    const gateContext: ActionGateContext<TCtx> = {
      ctx: context,
      scope: { kind: "collection", name: invocation.scope },
      invocation: { kind: "action", name: invocation.name },
      permission: definition.permission,
      target: { id, doc },
    };
    const grant = await policy.evaluateAction(definition, context, invocation, gateContext, doc);
    // The document is already loaded. Concealment (ADR 0015) applies to CRUD
    // get / update / delete / set, not to a gate that denied a found target.
    if (!allows(grant, definition.permission)) {
      throw new ForbiddenError("Forbidden", denialReasonOf(grant, definition.permission));
    }
    return { ...identified, storage, grant, document: doc };
  }

  const gateContext: ActionGateContext<TCtx> = {
    ctx: context,
    scope:
      invocation.scope === "$" ? { kind: "root" } : { kind: "collection", name: invocation.scope },
    invocation: { kind: "action", name: invocation.name },
    permission: definition.permission,
  };
  const grant = await policy.evaluateAction(definition, context, invocation, gateContext);
  if (!allows(grant, definition.permission)) {
    throw new ForbiddenError("Forbidden", denialReasonOf(grant, definition.permission));
  }
  return { ...identified, storage, grant };
}

export async function resolveAction<TCtx extends object>(args: {
  registry: ActionRegistry;
  collections: CollectionsDef<TCtx>;
  storage: StorageDriver;
  ctx: TCtx;
  invocation: ActionInvocation;
  logger?: InternalLogger;
  services?: unknown;
  policy: PolicySurface;
  schema: SchemaSurface;
}): Promise<ResolvedAction<TCtx>> {
  const identified = await identifyAction(args);
  const authorized = await authorizeIdentifiedAction<TCtx, typeof identified>(
    identified,
    args.storage,
  );
  return parseIdentifiedAction(authorized);
}

export async function parseIdentifiedAction<
  T extends Pick<IdentifiedAction<object>, "definition" | "invocation" | "rawInput" | "schema">,
>(identified: T): Promise<T & { readonly input: unknown }> {
  const { definition, invocation, schema } = identified;
  const hasInput = Object.prototype.hasOwnProperty.call(invocation, "input");
  let input: unknown;
  if (definition.inputSchema) {
    input = await schema.parse(definition.inputSchema, hasInput ? identified.rawInput : undefined);
  } else if (hasInput) {
    throw new BadRequestError(`Action does not accept input: ${invocation.name}`);
  }
  return { ...identified, input };
}

export async function executeResolvedAction<TCtx extends object>(
  resolved: ResolvedAction<TCtx>,
  handler: ActionHandlerSurface,
  reuseTransaction = false,
): Promise<JsonValue> {
  const {
    invocation,
    context,
    definition,
    input,
    document,
    collections,
    storage,
    logger,
    services,
  } = resolved;
  const scopedArgs = (scopedStorage: StorageDriver) => {
    const policyCollections = createPolicyCollections(
      collections,
      scopedStorage,
      context,
      logger,
      reuseTransaction,
    );
    const trustedCollections = createTrustedCollections(
      collections,
      scopedStorage,
      logger,
      definition.atomic,
    );
    const args: Record<string, unknown> = {
      ctx: context,
      collections: policyCollections,
      $collections: trustedCollections,
      services,
    };
    if (invocation.scope !== "$") {
      const collection = policyCollections[invocation.scope];
      if (!collection) {
        throw new NotFoundError(`Unknown collection: ${invocation.scope}`);
      }
      args.collection = collection;
      args.$collection = trustedCollections[invocation.scope];
    }
    return args;
  };

  if (definition.kind === "collection" && definition.target === "document") {
    const id = invocation.id!;
    return handler.run({ input, id, doc: document, ...scopedArgs(storage) });
  }

  return handler.run({ input, ...scopedArgs(storage) });
}

async function applyGuards(guards: readonly ActionGuardFn[], ctx: unknown): Promise<unknown> {
  let current = ctx;
  for (const guard of guards) {
    current = await guard(current);
  }
  return current;
}
