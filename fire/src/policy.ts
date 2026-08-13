import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AccessAction,
  AccessContext,
  AccessGrant,
  AccessPolicy,
  AccessPolicyFn,
  WithMetadata,
} from "./types";

export type InferPolicyDoc<TSchema extends StandardSchemaV1> = WithMetadata<
  StandardSchemaV1.InferOutput<TSchema>
>;

const ALL_ACTIONS = [
  "create",
  "get",
  "list",
  "update",
  "delete",
] as const satisfies readonly AccessAction[];

function freezeGrant(actions: readonly AccessAction[]): AccessGrant {
  return Object.freeze(new Set(actions));
}

/** Build a grant from explicit actions. `write` includes every action; `read` is get+list. */
export function grant(...actions: AccessAction[]): AccessGrant {
  return freezeGrant(actions);
}

export const none: AccessGrant = grant();
export const read: AccessGrant = grant("get", "list");
export const write: AccessGrant = grant(...ALL_ACTIONS);

export function isAccessGrant(value: unknown): value is AccessGrant {
  return value instanceof Set;
}

export function allows(decision: AccessGrant, action: AccessAction): boolean {
  return decision.has(action);
}

export async function evaluateAccessPolicy<TCtx, TDoc>(
  policy: AccessPolicy<TCtx, TDoc>,
  ctx: AccessContext<TCtx, TDoc>,
): Promise<AccessGrant> {
  if (isAccessGrant(policy)) return policy;
  return await policy(ctx);
}

function intersect(left: AccessGrant, right: AccessGrant): AccessGrant {
  const out = new Set<AccessAction>();
  for (const action of left) {
    if (right.has(action)) out.add(action);
  }
  return out;
}

function union(left: AccessGrant, right: AccessGrant): AccessGrant {
  return new Set<AccessAction>([...left, ...right]);
}

function isFullWrite(decision: AccessGrant): boolean {
  for (const action of ALL_ACTIONS) {
    if (!decision.has(action)) return false;
  }
  return true;
}

/**
 * Combine policies with AND (grant intersection). Each policy sees the same
 * access context. Schema-less policies stay reusable; a schema-bound policy
 * keeps the combined function tied to that document type.
 */
export function and<TCtx, TDoc>(
  ...policies: [AccessPolicy<TCtx, TDoc>, ...AccessPolicy<TCtx, TDoc>[]]
): AccessPolicyFn<TCtx, TDoc> {
  return async (ctx) => {
    let acc: AccessGrant | undefined;
    for (const policy of policies) {
      const next = await evaluateAccessPolicy(policy, ctx);
      acc = acc ? intersect(acc, next) : next;
      if (acc.size === 0) return none;
    }
    return acc ?? none;
  };
}

/**
 * Combine policies with OR (grant union). Each policy sees the same access
 * context. Schema-less policies stay reusable; a schema-bound policy keeps
 * the combined function tied to that document type.
 */
export function or<TCtx, TDoc>(
  ...policies: [AccessPolicy<TCtx, TDoc>, ...AccessPolicy<TCtx, TDoc>[]]
): AccessPolicyFn<TCtx, TDoc> {
  return async (ctx) => {
    let acc: AccessGrant = none;
    for (const policy of policies) {
      acc = union(acc, await evaluateAccessPolicy(policy, ctx));
      if (isFullWrite(acc)) return write;
    }
    return acc;
  };
}

export type PolicyHelper<TCtx> = {
  /**
   * Bind `doc` / `nextDoc` to a resource schema. `user` and the rest of
   * execution context come from `resolve`. The schema is type-only.
   */
  <TSchema extends StandardSchemaV1>(
    schema: TSchema,
    policy: AccessPolicy<TCtx, InferPolicyDoc<TSchema>>,
  ): AccessPolicy<TCtx, InferPolicyDoc<TSchema>>;
  /**
   * Context-only policy (identity, role, …). Assignable to every resource
   * that shares this execution context.
   */
  (policy: AccessPolicy<TCtx, unknown>): AccessPolicy<TCtx, unknown>;
};

/**
 * Type-safe `accessPolicy` helper. Runtime is identity — inference is the
 * contract. Use the schema overload so document fields are checked; omit the
 * schema when the rule only looks at `user`. Return a grant (`write` / `read`
 * / `none` / `grant(...)`), not a boolean.
 */
export function createPolicyHelper<TCtx>(): PolicyHelper<TCtx> {
  function policy(
    schemaOrPolicy: StandardSchemaV1 | AccessPolicy<TCtx, unknown>,
    maybePolicy?: AccessPolicy<TCtx, unknown>,
  ): AccessPolicy<TCtx, unknown> {
    if (maybePolicy) return maybePolicy;
    return schemaOrPolicy as AccessPolicy<TCtx, unknown>;
  }
  return policy as PolicyHelper<TCtx>;
}
