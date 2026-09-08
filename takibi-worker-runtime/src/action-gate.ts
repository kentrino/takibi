import {
  TakibiError,
  type ActionGateContext,
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

export async function resolveGateGrant<TCtx extends object>(
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
