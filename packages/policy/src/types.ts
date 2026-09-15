import type { CollectionOperation, QueryExpr, WithMetadata } from "@takibi/shared-types";

export type { CollectionOperation };

export type AccessPermission = "create" | "get" | "list" | "update" | "delete" | "invoke";

declare const accessGrantBrand: unique symbol;
declare const policyReasonCodeBrand: unique symbol;

/** @internal Type-only carrier used to preserve policy reason literals. */
export type PolicyReasonCodeCarrier<TCode extends string> = {
  readonly [policyReasonCodeBrand]: TCode;
};

/** Extract the policy reason code union carried by a policy definition. */
export type PolicyReasonCodeOf<T> =
  T extends PolicyReasonCodeCarrier<infer TCode extends string> ? TCode : never;

/** Opaque grant a policy returns. Build with `grant(...)` or a predefined grant. */
export type AccessGrant = {
  readonly [accessGrantBrand]: true;
};

export type AccessContext<
  TCtx extends object,
  TDoc = WithMetadata<Record<string, unknown>>,
> = TCtx & {
  collection: string;
  operation: CollectionOperation | "invoke";
  permission: AccessPermission;
  /** Normalized list query. Present only when list was called with `where`. */
  where?: QueryExpr;
  /**
   * Saved document for get / update / delete / existing set, and the target
   * document for a document action gate (`invoke`). Absent for add / list /
   * new set.
   */
  doc?: TDoc;
  /** Validated write candidate for add / update / set. Absent for get / delete / list / invoke. */
  nextDoc?: TDoc;
};

/**
 * Capability producer: return the actions this subject may perform on this
 * collection / document. Prefer not switching on `permission` — the executor
 * collates the grant against the required permission.
 */
export type AccessPolicyFn<TCtx extends object, TDoc = WithMetadata<Record<string, unknown>>> = (
  ctx: AccessContext<TCtx, TDoc>,
) => AccessGrant | Promise<AccessGrant>;

/**
 * `accessPolicy` value: a function, or a constant grant
 * (`fullAccess`, `write`, `read`, `none`).
 */
export type AccessPolicy<TCtx extends object, TDoc = WithMetadata<Record<string, unknown>>> =
  | AccessGrant
  | AccessPolicyFn<TCtx, TDoc>;

export type ListDecision =
  | { readonly kind: "deny" }
  | { readonly kind: "allowAll" }
  | { readonly kind: "allowWhere"; readonly where: QueryExpr };
