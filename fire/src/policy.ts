import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AccessPolicy, WithMetadata } from "./types";

export type InferPolicyDoc<TSchema extends StandardSchemaV1> = WithMetadata<
  StandardSchemaV1.InferOutput<TSchema>
>;

/**
 * Combine policies with AND. Each policy sees the same access context; the
 * first `false` fails the check. Schema-less policies stay reusable; a
 * schema-bound policy keeps the combined function tied to that document type.
 */
export function and<TCtx, TDoc>(
  ...policies: [AccessPolicy<TCtx, TDoc>, ...AccessPolicy<TCtx, TDoc>[]]
): AccessPolicy<TCtx, TDoc> {
  return async (ctx) => {
    for (const policy of policies) {
      if (!(await policy(ctx))) return false;
    }
    return true;
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
 * schema when the rule only looks at `user` / `action`.
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
