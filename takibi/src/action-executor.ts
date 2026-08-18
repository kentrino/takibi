import { ActionRegistry, type ActionGateContext } from "./action";
import { BadRequestError, TakibiError, ForbiddenError, NotFoundError } from "./errors";
import { createPolicyCollections, createTrustedCollections } from "./executor";
import { allows, isAccessGrant, isContextPolicy } from "./policy";
import { parseSchema } from "./schema";
import type { CollectionsDef, JsonValue, StorageDriver } from "./types";

export type ActionInvocation = {
  kind: "action";
  scope: string;
  name: string;
  input?: unknown;
};

export async function executeAction<TCtx extends { tenantId: string; user: unknown }>(
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

  const policyCollections = createPolicyCollections(collections, storage, ctx);
  const trustedCollections = createTrustedCollections(collections, storage);
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

  const output = await definition.handler(args as never);
  if (output === undefined) return null;
  assertJsonValue(output);
  return output;
}

function assertJsonValue(value: unknown, seen = new Set<object>()): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TakibiError("INVALID_ACTION_OUTPUT", "Action output must be JSON-safe", 500);
  }
  if (seen.has(value)) {
    throw new TakibiError("INVALID_ACTION_OUTPUT", "Action output must not be cyclic", 500);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TakibiError(
          "INVALID_ACTION_OUTPUT",
          "Action output arrays must contain only data elements",
          500,
        );
      }
      assertJsonValue(descriptor.value, seen);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw new TakibiError(
          "INVALID_ACTION_OUTPUT",
          "Action output arrays must not have custom properties",
          500,
        );
      }
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TakibiError(
      "INVALID_ACTION_OUTPUT",
      "Action output must contain only plain JSON objects",
      500,
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TakibiError(
        "INVALID_ACTION_OUTPUT",
        "Action output must not contain symbol properties",
        500,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TakibiError(
        "INVALID_ACTION_OUTPUT",
        "Action output must contain only enumerable data properties",
        500,
      );
    }
    assertJsonValue(descriptor.value, seen);
  }
  seen.delete(value);
}
