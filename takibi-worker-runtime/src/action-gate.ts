import {
  TakibiError,
  type ActionGateContext,
  type DocumentGateContext,
  type RuntimeActionDefinition,
} from "@takibi/takibi-api";
import {
  evaluateAccessPolicy,
  isAccessGrant,
  isConstrainedPolicy,
  isContextPolicy,
  type AccessGrant,
} from "@takibi/takibi-policy";
import type { ActionRequestData } from "@takibi/takibi-shared-types";

export type ActionInvocation = ActionRequestData;

type DetachedGateContext = ActionGateContext<unknown, never> & { readonly target?: never };

type GateTarget =
  | {
      readonly kind: "document";
      readonly context: DocumentGateContext<unknown, unknown>;
      readonly doc: unknown;
    }
  | {
      readonly kind: "detached";
      readonly context: DetachedGateContext;
    };

export async function resolveGateGrant(
  definition: RuntimeActionDefinition,
  ctx: unknown,
  invocation: ActionInvocation,
  gateContext: ActionGateContext<unknown>,
  doc: unknown,
): Promise<AccessGrant> {
  if (isAccessGrant(definition.policy)) return definition.policy;
  if (isContextPolicy(definition.policy)) return definition.policy(ctx);
  const target = resolveGateTarget(definition, invocation, gateContext, doc);
  if (isConstrainedPolicy(definition.policy)) {
    if (target.kind === "detached") throw invalidDocumentGate(invocation.name);
    return evaluateAccessPolicy(definition.policy, {
      ...contextProperties(ctx),
      collection: invocation.scope,
      operation: "invoke",
      permission: definition.permission,
      doc: target.doc,
    });
  }
  const policy = definition.policy as (
    context: ActionGateContext<unknown>,
  ) => AccessGrant | Promise<AccessGrant>;
  return policy(target.context);
}

function resolveGateTarget(
  definition: RuntimeActionDefinition,
  invocation: ActionInvocation,
  gateContext: ActionGateContext<unknown>,
  doc: unknown,
): GateTarget {
  if (definition.kind === "collection" && definition.target === "document") {
    if (gateContext.target === undefined || doc === undefined) {
      throw invalidDocumentGate(invocation.name);
    }
    return {
      kind: "document",
      context: { ...gateContext, target: gateContext.target },
      doc,
    };
  }
  if (gateContext.target !== undefined || doc !== undefined) {
    throw new TakibiError(
      "INVALID_ACTION",
      `Detached and root action gates cannot have a document target: ${invocation.name}`,
      500,
    );
  }
  return {
    kind: "detached",
    context: {
      ctx: gateContext.ctx,
      scope: gateContext.scope,
      invocation: gateContext.invocation,
      permission: gateContext.permission,
    },
  };
}

function invalidDocumentGate(name: string): TakibiError {
  return new TakibiError(
    "INVALID_ACTION",
    `Schema-bound policies require a document action gate: ${name}`,
    500,
  );
}

/** Convert any guard output with the same property rules as an object spread. */
function contextProperties(ctx: unknown): object {
  return ctx == null ? {} : Object(ctx);
}
