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

/**
 * Already-available decision inputs: application context resolved before dispatch,
 * plus the operation's document candidates and query. Prepare external identity
 * and membership in `createTakibi()({ resolve, stub })`; return JSON-safe data,
 * preserving routing inputs. This is point-in-time data, not an external-service
 * snapshot or a guarantee of immediate revocation or cross-row consistency.
 *
 * Evaluate locally without external HTTP or other awaited I/O. Do not await a
 * root facade/storage operation or fetch/RPC back into the same Durable Object:
 * policy may hold a transaction that the queued operation needs to finish.
 * These are caller obligations, not runtime I/O/reentry detection guarantees.
 * Local computation returning a Promise remains supported.
 */
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
 *
 * Compute locally from AccessContext, doc/nextDoc, and query. A Promise is legal
 * for local computation; do not await external HTTP or other I/O, another root
 * facade/storage operation, or fetch/RPC into the same Durable Object. External
 * I/O prolongs transaction occupancy; queued root reentry can circularly wait.
 * Takibi does not promise runtime detection, immediate rejection, or timeouts.
 *
 * Prepare serializable external inputs in `resolve` before dispatch, not in an
 * atomic handler, document guard, or gate. Even `add` policy can run inside an
 * enclosing transaction. Keep authorization, revision, and uniqueness isolation
 * intact. Pre-resolved inputs do not guarantee immediate external revocation or
 * cross-row/external consistency; those require separate design.
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
