import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { PolicyReason, WithMetadata } from "@takibi/shared-types";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  AccessPolicy,
  AccessPolicyFn,
  PolicyReasonCodeCarrier,
  PolicyReasonCodeOf,
} from "./types";

export type InferPolicyDoc<TSchema extends StandardSchemaV1> = WithMetadata<
  StandardSchemaV1.InferOutput<TSchema>
>;

/**
 * Schema-bound policy. Assigns to a collection when every pick-schema key exists
 * on the collection document — optional vs required does not matter.
 */
type ReasonCodeCarrier<TCode extends string> = [TCode] extends [never]
  ? object
  : PolicyReasonCodeCarrier<TCode>;

export type ConstrainedPolicy<TCtx extends object, TPick, TReasonCode extends string = never> = (<
  TDoc,
>(
  ctx: AccessContext<TCtx, keyof TPick extends keyof TDoc ? TDoc : never>,
) => AccessGrant | Promise<AccessGrant>) &
  ReasonCodeCarrier<TReasonCode>;

type CombinablePolicy<TCtx extends object, TDoc> =
  | AccessPolicy<TCtx, TDoc>
  | ConstrainedPolicy<TCtx, TDoc, string>
  | ContextPolicy<TCtx, string>;

export const contextPolicyBrand: unique symbol = Symbol("fire.contextPolicy");
type ContextPolicyFn<TCtx> = (ctx: TCtx) => AccessGrant | Promise<AccessGrant>;
export type ContextPolicy<TCtx, TReasonCode extends string = never> = {
  (ctx: TCtx): AccessGrant | Promise<AccessGrant>;
  readonly [contextPolicyBrand]: true;
} & ReasonCodeCarrier<TReasonCode>;

export const constrainedPolicyBrand: unique symbol = Symbol("fire.constrainedPolicy");

export function isContextPolicy(value: unknown): value is ContextPolicy<unknown> {
  return (
    typeof value === "function" &&
    (value as Partial<ContextPolicy<unknown>>)[contextPolicyBrand] === true
  );
}

export function isConstrainedPolicy(value: unknown): value is ConstrainedPolicy<object, unknown> {
  return (
    typeof value === "function" &&
    (value as { readonly [constrainedPolicyBrand]?: true })[constrainedPolicyBrand] === true
  );
}

function brandConstrainedPolicy<T extends object>(policy: T): T {
  Object.defineProperty(policy, constrainedPolicyBrand, {
    value: true,
    enumerable: false,
  });
  return policy;
}

function createComposedPolicy<TCtx extends object, TDoc, TReasonCode extends string>(
  policy: AccessPolicyFn<TCtx, TDoc>,
): ConstrainedPolicy<TCtx, TDoc, TReasonCode> {
  return brandConstrainedPolicy(policy) as unknown as ConstrainedPolicy<TCtx, TDoc, TReasonCode>;
}

const WRITE_PERMISSIONS = [
  "create",
  "update",
  "delete",
] as const satisfies readonly AccessPermission[];

const ALL_PERMISSIONS = [
  "create",
  "get",
  "list",
  "update",
  "delete",
  "invoke",
] as const satisfies readonly AccessPermission[];

type GrantCatalog = { readonly [K in AccessPermission]: K };

const GRANT_CATALOG: GrantCatalog = Object.freeze({
  create: "create",
  get: "get",
  list: "list",
  update: "update",
  delete: "delete",
  invoke: "invoke",
});

type DenialReasonMap = ReadonlyMap<AccessPermission, PolicyReason>;

const grantPermissions = new WeakMap<object, ReadonlySet<AccessPermission>>();
const grantDenialReasons = new WeakMap<object, DenialReasonMap>();

function createGrant(
  permissions: readonly AccessPermission[],
  denialReasons?: DenialReasonMap,
): AccessGrant {
  const value = Object.freeze({}) as AccessGrant;
  grantPermissions.set(value, new Set(permissions));
  if (denialReasons && denialReasons.size > 0) {
    grantDenialReasons.set(value, new Map(denialReasons));
  }
  return value;
}

export function permissionsOf(decision: AccessGrant): ReadonlySet<AccessPermission> {
  return grantPermissions.get(decision) ?? new Set();
}

/** Build a grant from explicit permissions or a catalog callback. */
export function grant(...permissions: AccessPermission[]): AccessGrant;
export function grant(select: (catalog: GrantCatalog) => readonly AccessPermission[]): AccessGrant;
export function grant(
  first?: AccessPermission | ((catalog: GrantCatalog) => readonly AccessPermission[]),
  ...rest: AccessPermission[]
): AccessGrant {
  if (typeof first === "function") return createGrant(first(GRANT_CATALOG));
  return createGrant(first === undefined ? rest : [first, ...rest]);
}

export const none: AccessGrant = grant();
export const read: AccessGrant = grant("get", "list");
export const write: AccessGrant = grant(...WRITE_PERMISSIONS);
export const fullAccess: AccessGrant = grant(...ALL_PERMISSIONS);

export function isAccessGrant(value: unknown): value is AccessGrant {
  return typeof value === "object" && value !== null && grantPermissions.has(value);
}

export function allows(decision: AccessGrant, permission: AccessPermission): boolean {
  return permissionsOf(decision).has(permission);
}

/** @internal Return the public reason attributed to a denied permission. */
export function denialReasonOf(
  decision: AccessGrant,
  permission: AccessPermission,
): PolicyReason | undefined {
  return grantDenialReasons.get(decision)?.get(permission);
}

export async function evaluateAccessPolicy<TCtx extends object, TDoc>(
  policy: CombinablePolicy<TCtx, TDoc>,
  ctx: AccessContext<TCtx, TDoc>,
): Promise<AccessGrant> {
  if (isAccessGrant(policy)) return policy;
  return await (policy as AccessPolicyFn<TCtx, TDoc>)(ctx);
}

function isEmpty(decision: AccessGrant): boolean {
  return permissionsOf(decision).size === 0;
}

function isFullAccess(decision: AccessGrant): boolean {
  const granted = permissionsOf(decision);
  for (const permission of ALL_PERMISSIONS) {
    if (!granted.has(permission)) return false;
  }
  return true;
}

function composedGrant(
  permissions: ReadonlySet<AccessPermission>,
  reasons: ReadonlyMap<AccessPermission, PolicyReason>,
): AccessGrant {
  if (reasons.size === 0) {
    if (permissions.size === 0) return none;
    if (permissions.size === ALL_PERMISSIONS.length) return fullAccess;
  }
  return createGrant([...permissions], reasons);
}

/**
 * Combine policies with AND (grant intersection). `TDoc` is inferred from the
 * arguments: schema-bound policies keep their pick, schema-less ones do not
 * widen it away.
 */
export function and<
  TCtx extends object,
  TDoc,
  const TPolicies extends readonly [unknown, ...unknown[]],
>(
  ...policies: TPolicies & [CombinablePolicy<TCtx, TDoc>, ...CombinablePolicy<TCtx, TDoc>[]]
): ConstrainedPolicy<TCtx, TDoc, PolicyReasonCodeOf<TPolicies[number]>> {
  return createComposedPolicy<TCtx, TDoc, PolicyReasonCodeOf<TPolicies[number]>>(async (ctx) => {
    const permissions = new Set<AccessPermission>(ALL_PERMISSIONS);
    const reasons = new Map<AccessPermission, PolicyReason>();
    for (const policy of policies) {
      const next = await evaluateAccessPolicy(policy, ctx);
      for (const permission of permissions) {
        if (allows(next, permission)) continue;
        permissions.delete(permission);
        const reason = denialReasonOf(next, permission);
        if (reason) reasons.set(permission, reason);
      }
      const acc = composedGrant(permissions, reasons);
      if (isEmpty(acc)) return acc;
    }
    return composedGrant(permissions, reasons);
  });
}

/**
 * Combine policies with OR (grant union). `TDoc` is inferred from the
 * arguments the same way as `and`.
 */
export function or<
  TCtx extends object,
  TDoc,
  const TPolicies extends readonly [unknown, ...unknown[]],
>(
  ...policies: TPolicies & [CombinablePolicy<TCtx, TDoc>, ...CombinablePolicy<TCtx, TDoc>[]]
): ConstrainedPolicy<TCtx, TDoc, PolicyReasonCodeOf<TPolicies[number]>> {
  const inputPolicies: readonly CombinablePolicy<TCtx, TDoc>[] = policies;
  return createComposedPolicy<TCtx, TDoc, PolicyReasonCodeOf<TPolicies[number]>>(async (ctx) => {
    const permissions = new Set<AccessPermission>();
    const firstReasons = new Map<AccessPermission, PolicyReason>();
    for (const [index, policy] of inputPolicies.entries()) {
      const next = await evaluateAccessPolicy(policy, ctx);
      if (index === 0) {
        for (const permission of ALL_PERMISSIONS) {
          const reason = denialReasonOf(next, permission);
          if (reason) firstReasons.set(permission, reason);
        }
      }
      for (const permission of permissionsOf(next)) permissions.add(permission);
      const acc = composedGrant(permissions, new Map());
      if (isFullAccess(acc)) return fullAccess;
    }
    const reasons = new Map<AccessPermission, PolicyReason>();
    for (const permission of ALL_PERMISSIONS) {
      if (permissions.has(permission)) continue;
      const reason = firstReasons.get(permission);
      if (reason) reasons.set(permission, reason);
    }
    return composedGrant(permissions, reasons);
  });
}

type SchemaPolicyOptions<TSchema extends StandardSchemaV1, TCode extends string> = {
  readonly schema: TSchema;
  readonly reason: PolicyReason<TCode>;
};

type ContextPolicyOptions<TCode extends string> = {
  readonly reason: PolicyReason<TCode>;
};

export type PolicyHelper<TCtx extends object> = {
  /**
   * Bind `doc` / `nextDoc` in the callback to a collection schema (or a pick of
   * its fields). The returned policy assigns to a collection iff those keys
   * exist on the document; optional vs required does not matter.
   */
  <TSchema extends StandardSchemaV1>(
    schema: TSchema,
    policy: AccessPolicy<TCtx, InferPolicyDoc<TSchema>>,
  ): ConstrainedPolicy<TCtx, InferPolicyDoc<TSchema>>;
  <TSchema extends StandardSchemaV1, const TCode extends string>(
    options: SchemaPolicyOptions<TSchema, TCode>,
    policy: AccessPolicy<TCtx, InferPolicyDoc<TSchema>>,
  ): ConstrainedPolicy<TCtx, InferPolicyDoc<TSchema>, TCode>;
  /**
   * Context-only policy (identity, role, …). Assignable to every collection
   * that shares this execution context.
   */
  (policy: AccessGrant | ContextPolicyFn<TCtx>): AccessGrant | ContextPolicy<TCtx>;
  <const TCode extends string>(
    options: ContextPolicyOptions<TCode>,
    policy: AccessGrant | ContextPolicyFn<TCtx>,
  ): ContextPolicy<TCtx, TCode>;
};

/**
 * Type-safe `accessPolicy` helper. Runtime is identity — inference is the
 * contract. Use the schema overload so document fields are checked; omit the
 * schema when the rule only looks at application context. Return a grant
 * (`fullAccess` / `write` / `read` / `none` / `grant(...)`), not a boolean.
 */
export function createPolicyHelper<TCtx extends object>(): PolicyHelper<TCtx> {
  function policy(
    schemaOrPolicy:
      | StandardSchemaV1
      | SchemaPolicyOptions<StandardSchemaV1, string>
      | ContextPolicyOptions<string>
      | AccessPolicy<TCtx, unknown>
      | ContextPolicyFn<TCtx>,
    maybePolicy?: AccessPolicy<TCtx, unknown>,
  ): AccessPolicy<TCtx, unknown> | ContextPolicy<TCtx> {
    if (maybePolicy) {
      if (isPolicyOptions(schemaOrPolicy)) {
        const wrapped = withStaticReason(maybePolicy, schemaOrPolicy.reason);
        if ("schema" in schemaOrPolicy) return brandConstrainedPolicy(wrapped);
        return brandContextPolicy(wrapped);
      }
      if (isAccessGrant(maybePolicy)) return maybePolicy;
      return brandConstrainedPolicy(maybePolicy);
    }
    if (isAccessGrant(schemaOrPolicy)) return schemaOrPolicy;
    return brandContextPolicy(schemaOrPolicy as ContextPolicy<TCtx>);
  }
  return policy as PolicyHelper<TCtx>;
}

function brandContextPolicy<T extends object>(policy: T): T {
  Object.defineProperty(policy, contextPolicyBrand, {
    value: true,
    enumerable: false,
  });
  return policy;
}

function isPolicyOptions(
  value: unknown,
): value is SchemaPolicyOptions<StandardSchemaV1, string> | ContextPolicyOptions<string> {
  return typeof value === "object" && value !== null && !isAccessGrant(value) && "reason" in value;
}

function withStaticReason<TCtx extends object>(
  policy: AccessPolicy<TCtx, unknown>,
  reason: PolicyReason,
): AccessPolicyFn<TCtx, unknown> {
  const safeReason = Object.freeze({
    code: reason.code,
    ...(reason.description === undefined ? {} : { description: reason.description }),
  });
  const evaluate = isAccessGrant(policy) ? () => policy : policy;
  return async (ctx) => {
    const decision = await evaluate(ctx);
    if (!isAccessGrant(decision)) return decision;
    const reasons = new Map<AccessPermission, PolicyReason>();
    for (const permission of ALL_PERMISSIONS) {
      if (!allows(decision, permission)) reasons.set(permission, safeReason);
    }
    return createGrant([...permissionsOf(decision)], reasons);
  };
}
