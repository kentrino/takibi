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

/**
 * Schema-bound policy. Assigns to a resource when every pick-schema key exists
 * on the resource document — optional vs required does not matter.
 */
export type ConstrainedPolicy<TCtx, TPick> = <TDoc>(
  ctx: AccessContext<TCtx, keyof TPick extends keyof TDoc ? TDoc : never>,
) => AccessGrant | Promise<AccessGrant>;

type CombinablePolicy<TCtx, TDoc> = AccessPolicy<TCtx, TDoc> | ConstrainedPolicy<TCtx, TDoc>;

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
  policy: CombinablePolicy<TCtx, TDoc>,
  ctx: AccessContext<TCtx, TDoc>,
): Promise<AccessGrant> {
  if (isAccessGrant(policy)) return policy;
  return await (policy as AccessPolicyFn<TCtx, TDoc>)(ctx);
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
 * Combine policies with AND (grant intersection). `TDoc` is inferred from the
 * arguments: schema-bound policies keep their pick, schema-less ones do not
 * widen it away.
 */
export function and<TCtx, TDoc>(
  ...policies: [CombinablePolicy<TCtx, TDoc>, ...CombinablePolicy<TCtx, TDoc>[]]
): ConstrainedPolicy<TCtx, TDoc> {
  return (async (ctx) => {
    let acc: AccessGrant | undefined;
    for (const policy of policies) {
      const next = await evaluateAccessPolicy(policy, ctx as AccessContext<TCtx, TDoc>);
      acc = acc ? intersect(acc, next) : next;
      if (acc.size === 0) return none;
    }
    return acc ?? none;
  }) as ConstrainedPolicy<TCtx, TDoc>;
}

/**
 * Combine policies with OR (grant union). `TDoc` is inferred from the
 * arguments the same way as `and`.
 */
export function or<TCtx, TDoc>(
  ...policies: [CombinablePolicy<TCtx, TDoc>, ...CombinablePolicy<TCtx, TDoc>[]]
): ConstrainedPolicy<TCtx, TDoc> {
  return (async (ctx) => {
    let acc: AccessGrant = none;
    for (const policy of policies) {
      acc = union(acc, await evaluateAccessPolicy(policy, ctx as AccessContext<TCtx, TDoc>));
      if (isFullWrite(acc)) return write;
    }
    return acc;
  }) as ConstrainedPolicy<TCtx, TDoc>;
}

export type PolicyHelper<TCtx> = {
  /**
   * Bind `doc` / `nextDoc` in the callback to a resource schema (or a pick of
   * its fields). The returned policy assigns to a resource iff those keys
   * exist on the document; optional vs required does not matter.
   */
  <TSchema extends StandardSchemaV1>(
    schema: TSchema,
    policy: AccessPolicy<TCtx, InferPolicyDoc<TSchema>>,
  ): ConstrainedPolicy<TCtx, InferPolicyDoc<TSchema>>;
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
