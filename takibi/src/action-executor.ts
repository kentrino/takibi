import {
  ActionRegistry,
  type ActionGateContext,
  type ActionGuardFn,
  type RuntimeActionDefinition,
} from "./action";
import { BadRequestError, TakibiError, ForbiddenError, NotFoundError } from "./errors";
import { createPolicyCollections, createTrustedCollections } from "./executor";
import { assertJsonValue } from "./json";
import { withLoggedSpan, type InternalLogger } from "./logging";
import { actionSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import {
  allows,
  denialReasonOf,
  evaluateAccessPolicy,
  isAccessGrant,
  isConstrainedPolicy,
  isContextPolicy,
} from "./policy";
import { parseSchema } from "./schema";
import type { AccessGrant, CollectionsDef, JsonValue, StorageDriver } from "./types";

export type ActionInvocation = {
  kind: "action";
  scope: string;
  name: string;
  /** Target document id. Present exactly for document actions. */
  id?: string;
  input?: unknown;
};

/**
 * Run a registered action. The envelope must already be a valid
 * `ActionInvocation` from `decodeWireRequest` (or an equivalent trusted
 * constructor). This function does not re-check wire shape.
 */
export async function executeAction<TCtx extends object>(
  registry: ActionRegistry,
  collections: CollectionsDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  invocation: ActionInvocation,
  logger?: InternalLogger,
): Promise<JsonValue> {
  const registered = registry.get(invocation.scope, invocation.name);
  if (!registered) {
    throw new NotFoundError(`Unknown action: ${invocation.name}`);
  }

  const { definition } = registered;
  const isDocument = definition.kind === "collection" && definition.target === "document";
  const hasId = Object.prototype.hasOwnProperty.call(invocation, "id");
  if (isDocument) {
    if (typeof invocation.id !== "string" || invocation.id === "") {
      throw new BadRequestError(`Document action requires an id: ${invocation.name}`);
    }
  } else if (hasId) {
    throw new BadRequestError(`Action does not take a document id: ${invocation.name}`);
  }

  // Guards run before document load and gate evaluation so auth failures do
  // not reveal whether a target id exists.
  const actionCtx = (await applyGuards(definition.guards, ctx)) as TCtx;

  const spanAttributes = actionSpanAttributes(invocation.name, invocation.scope);
  const logFields = {
    ...(invocation.scope === "$" ? {} : { collection: invocation.scope }),
    operation: invocation.name,
    ...(invocation.id === undefined ? {} : { documentId: invocation.id }),
  };

  const parseInput = async (): Promise<unknown> => {
    const hasInput = Object.prototype.hasOwnProperty.call(invocation, "input");
    if (definition.inputSchema) {
      return parseSchema(definition.inputSchema, hasInput ? invocation.input : undefined, logger);
    }
    if (hasInput) {
      throw new BadRequestError(`Action does not accept input: ${invocation.name}`);
    }
    return undefined;
  };

  const scopedArgs = (scopedStorage: StorageDriver) => {
    const policyCollections = createPolicyCollections(
      collections,
      scopedStorage,
      actionCtx,
      logger,
    );
    const trustedCollections = createTrustedCollections(collections, scopedStorage, logger);
    const args: Record<string, unknown> = {
      ctx: actionCtx,
      collections: policyCollections,
      $collections: trustedCollections,
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

  const runHandler = async (args: Record<string, unknown>): Promise<JsonValue> => {
    const output = await withLoggedSpan(
      logger,
      { name: TAKIBI_SPAN.action, kind: "internal", attributes: spanAttributes },
      { event: "takibi.action", ...logFields },
      async () => definition.handler(args),
    );
    if (output === undefined) return null;
    assertJsonValue(output, {
      subject: "Action output",
      error: (message) => new TakibiError("INVALID_ACTION_OUTPUT", message, 500),
    });
    return output;
  };

  const evaluateGate = (gateContext: ActionGateContext<TCtx>, doc?: unknown) =>
    withLoggedSpan(
      logger,
      { name: TAKIBI_SPAN.policy, kind: "internal", attributes: spanAttributes },
      { event: "takibi.policy", ...logFields },
      async () => {
        const grant = await resolveGateGrant(definition, actionCtx, invocation, gateContext, doc);
        if (!isAccessGrant(grant)) {
          throw new TakibiError("INVALID_POLICY", "Action policy must return an AccessGrant", 500);
        }
        return grant;
      },
    );

  if (isDocument) {
    const id = invocation.id!;
    const run = async (scopedStorage: StorageDriver): Promise<JsonValue> => {
      if (!collections[invocation.scope]) {
        throw new NotFoundError(`Unknown collection: ${invocation.scope}`);
      }
      const doc = await scopedStorage.get(invocation.scope, id);
      if (!doc) throw new NotFoundError(`Document not found: ${id}`);
      const gateContext: ActionGateContext<TCtx> = {
        ctx: actionCtx,
        scope: { kind: "collection", name: invocation.scope },
        invocation: { kind: "action", name: invocation.name },
        permission: definition.permission,
        target: { id, doc },
      };
      const grant = await evaluateGate(gateContext, doc);
      // The document is already loaded. Concealment (ADR 0015) applies to CRUD
      // get / update / delete / set, not to a gate that denied a found target.
      if (!allows(grant, definition.permission)) {
        throw new ForbiddenError("Forbidden", denialReasonOf(grant, definition.permission));
      }
      const input = await parseInput();
      return runHandler({ input, id, doc, ...scopedArgs(scopedStorage) });
    };
    return definition.atomic ? storage.transaction(run) : run(storage);
  }

  const gateContext: ActionGateContext<TCtx> = {
    ctx: actionCtx,
    scope:
      invocation.scope === "$" ? { kind: "root" } : { kind: "collection", name: invocation.scope },
    invocation: { kind: "action", name: invocation.name },
    permission: definition.permission,
  };
  const grant = await evaluateGate(gateContext);
  if (!allows(grant, definition.permission)) {
    throw new ForbiddenError("Forbidden", denialReasonOf(grant, definition.permission));
  }
  const input = await parseInput();
  const run = async (scopedStorage: StorageDriver): Promise<JsonValue> =>
    runHandler({ input, ...scopedArgs(scopedStorage) });
  return definition.atomic ? storage.transaction(run) : run(storage);
}

async function applyGuards(guards: readonly ActionGuardFn[], ctx: unknown): Promise<unknown> {
  let current = ctx;
  for (const guard of guards) {
    current = await guard(current);
  }
  return current;
}

async function resolveGateGrant<TCtx extends object>(
  definition: RuntimeActionDefinition,
  ctx: TCtx,
  invocation: ActionInvocation,
  gateContext: ActionGateContext<TCtx>,
  doc: unknown,
): Promise<AccessGrant> {
  if (isAccessGrant(definition.policy)) return definition.policy;
  if (isContextPolicy(definition.policy)) return definition.policy(ctx);
  if (isConstrainedPolicy(definition.policy)) {
    // Registration rejects schema-bound gates on detached / root actions, so
    // a target document is always available here.
    if (doc === undefined) {
      throw new TakibiError(
        "INVALID_ACTION",
        `Schema-bound policies require a document action gate: ${invocation.name}`,
        500,
      );
    }
    return evaluateAccessPolicy(definition.policy, {
      ...ctx,
      collection: invocation.scope,
      operation: "invoke",
      permission: definition.permission,
      doc,
    });
  }
  return (
    definition.policy as (ctx: ActionGateContext<TCtx>) => AccessGrant | Promise<AccessGrant>
  )(gateContext);
}
