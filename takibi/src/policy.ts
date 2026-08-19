import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  AccessPolicy,
  AccessPolicyFn,
  WithMetadata,
} from "./types";

export type InferPolicyDoc<TSchema extends StandardSchemaV1> = WithMetadata<
  StandardSchemaV1.InferOutput<TSchema>
>;

/**
 * Schema-bound policy. Assigns to a collection when every pick-schema key exists
 * on the collection document — optional vs required does not matter.
 */
export type ConstrainedPolicy<TCtx extends object, TPick> = <TDoc>(
  ctx: AccessContext<TCtx, keyof TPick extends keyof TDoc ? TDoc : never>,
) => AccessGrant | Promise<AccessGrant>;

type CombinablePolicy<TCtx extends object, TDoc> =
  | AccessPolicy<TCtx, TDoc>
  | ConstrainedPolicy<TCtx, TDoc>;

export const contextPolicyBrand: unique symbol = Symbol("fire.contextPolicy");
type ContextPolicyFn<TCtx> = (ctx: TCtx) => AccessGrant | Promise<AccessGrant>;
export type ContextPolicy<TCtx> = {
  (ctx: TCtx): AccessGrant | Promise<AccessGrant>;
  readonly [contextPolicyBrand]: true;
};

export function isContextPolicy(value: unknown): value is ContextPolicy<unknown> {
  return (
    typeof value === "function" &&
    (value as Partial<ContextPolicy<unknown>>)[contextPolicyBrand] === true
  );
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

const grantPermissions = new WeakMap<object, ReadonlySet<AccessPermission>>();

function createGrant(permissions: readonly AccessPermission[]): AccessGrant {
  const value = Object.freeze({}) as AccessGrant;
  grantPermissions.set(value, new Set(permissions));
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

export async function evaluateAccessPolicy<TCtx extends object, TDoc>(
  policy: CombinablePolicy<TCtx, TDoc>,
  ctx: AccessContext<TCtx, TDoc>,
): Promise<AccessGrant> {
  if (isAccessGrant(policy)) return policy;
  return await (policy as AccessPolicyFn<TCtx, TDoc>)(ctx);
}

function intersect(left: AccessGrant, right: AccessGrant): AccessGrant {
  const rightSet = permissionsOf(right);
  return createGrant([...permissionsOf(left)].filter((permission) => rightSet.has(permission)));
}

function union(left: AccessGrant, right: AccessGrant): AccessGrant {
  return createGrant([...permissionsOf(left), ...permissionsOf(right)]);
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

/**
 * Combine policies with AND (grant intersection). `TDoc` is inferred from the
 * arguments: schema-bound policies keep their pick, schema-less ones do not
 * widen it away.
 */
export function and<TCtx extends object, TDoc>(
  ...policies: [CombinablePolicy<TCtx, TDoc>, ...CombinablePolicy<TCtx, TDoc>[]]
): ConstrainedPolicy<TCtx, TDoc> {
  return (async (ctx) => {
    let acc: AccessGrant | undefined;
    for (const policy of policies) {
      const next = await evaluateAccessPolicy(policy, ctx as AccessContext<TCtx, TDoc>);
      acc = acc ? intersect(acc, next) : next;
      if (isEmpty(acc)) return none;
    }
    return acc ?? none;
  }) as ConstrainedPolicy<TCtx, TDoc>;
}

/**
 * Combine policies with OR (grant union). `TDoc` is inferred from the
 * arguments the same way as `and`.
 */
export function or<TCtx extends object, TDoc>(
  ...policies: [CombinablePolicy<TCtx, TDoc>, ...CombinablePolicy<TCtx, TDoc>[]]
): ConstrainedPolicy<TCtx, TDoc> {
  return (async (ctx) => {
    let acc: AccessGrant = none;
    for (const policy of policies) {
      acc = union(acc, await evaluateAccessPolicy(policy, ctx as AccessContext<TCtx, TDoc>));
      if (isFullAccess(acc)) return fullAccess;
    }
    return acc;
  }) as ConstrainedPolicy<TCtx, TDoc>;
}

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
  /**
   * Context-only policy (identity, role, …). Assignable to every collection
   * that shares this execution context.
   */
  (policy: AccessGrant | ContextPolicyFn<TCtx>): AccessGrant | ContextPolicy<TCtx>;
};

/**
 * Type-safe `accessPolicy` helper. Runtime is identity — inference is the
 * contract. Use the schema overload so document fields are checked; omit the
 * schema when the rule only looks at application context. Return a grant
 * (`fullAccess` / `write` / `read` / `none` / `grant(...)`), not a boolean.
 */
export function createPolicyHelper<TCtx extends object>(): PolicyHelper<TCtx> {
  function policy(
    schemaOrPolicy: StandardSchemaV1 | AccessPolicy<TCtx, unknown> | ContextPolicyFn<TCtx>,
    maybePolicy?: AccessPolicy<TCtx, unknown>,
  ): AccessPolicy<TCtx, unknown> | ContextPolicy<TCtx> {
    if (maybePolicy) return maybePolicy;
    if (isAccessGrant(schemaOrPolicy)) return schemaOrPolicy;
    const contextPolicy = schemaOrPolicy as ContextPolicy<TCtx>;
    Object.defineProperty(contextPolicy, contextPolicyBrand, {
      value: true,
      enumerable: false,
    });
    return contextPolicy;
  }
  return policy as PolicyHelper<TCtx>;
}
