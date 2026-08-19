import { ActionRegistry, type ActionGateContext } from "./action";
import { BadRequestError, TakibiError, ForbiddenError, NotFoundError } from "./errors";
import { createPolicyCollections, createTrustedCollections } from "./executor";
import { assertJsonValue } from "./json";
import { allows, isAccessGrant, isContextPolicy } from "./policy";
import { parseSchema } from "./schema";
import { withSpan } from "./tracing";
import type { CollectionsDef, JsonValue, StorageDriver } from "./types";

export type ActionInvocation = {
  kind: "action";
  scope: string;
  name: string;
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
): Promise<JsonValue> {
  const registered = registry.get(invocation.scope, invocation.name);
  if (!registered) {
    throw new NotFoundError(`Unknown action: ${invocation.name}`);
  }

  const { definition } = registered;
  const gateContext: ActionGateContext<TCtx> = {
    ctx,
    scope:
      invocation.scope === "$" ? { kind: "root" } : { kind: "collection", name: invocation.scope },
    invocation: { kind: "action", name: invocation.name },
    permission: definition.permission,
  };
  await withSpan("takibi.policy", async () => {
    const grant = isAccessGrant(definition.policy)
      ? definition.policy
      : isContextPolicy(definition.policy)
        ? await definition.policy(ctx)
        : await definition.policy(gateContext);
    if (!isAccessGrant(grant)) {
      throw new TakibiError("INVALID_POLICY", "Action policy must return an AccessGrant", 500);
    }
    if (!allows(grant, definition.permission)) {
      throw new ForbiddenError();
    }
  });

  const hasInput = Object.prototype.hasOwnProperty.call(invocation, "input");
  let input: unknown;
  if (definition.inputSchema) {
    input = await parseSchema(definition.inputSchema, hasInput ? invocation.input : undefined);
  } else {
    if (hasInput) {
      throw new BadRequestError(`Action does not accept input: ${invocation.name}`);
    }
    input = undefined;
  }

  const runHandler = async (scopedStorage: StorageDriver): Promise<JsonValue> => {
    const policyCollections = createPolicyCollections(collections, scopedStorage, ctx);
    const trustedCollections = createTrustedCollections(collections, scopedStorage);
    const args =
      invocation.scope === "$"
        ? {
            input,
            ctx,
            collections: policyCollections,
            $collections: trustedCollections,
          }
        : {
            input,
            ctx,
            collection: policyCollections[invocation.scope],
            $collection: trustedCollections[invocation.scope],
          };

    if (invocation.scope !== "$" && !("collection" in args && args.collection)) {
      throw new NotFoundError(`Unknown collection: ${invocation.scope}`);
    }

    const output = await withSpan("takibi.action", () => definition.handler(args));
    if (output === undefined) return null;
    assertJsonValue(output, {
      subject: "Action output",
      error: (message) => new TakibiError("INVALID_ACTION_OUTPUT", message, 500),
    });
    return output;
  };

  return definition.atomic ? storage.transaction(runHandler) : runHandler(storage);
}
