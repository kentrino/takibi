import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AccessContext, ResourceDefinition, WithMetadata } from "./types";

/**
 * Tie `accessPolicy`'s `doc` / `nextDoc` to a concrete schema.
 * Prefer this when policies read document fields; bare object literals in
 * `resources({ ... })` cannot reverse-infer schema into the callback parameter.
 */
export function defineResource<TSchema extends StandardSchemaV1, TCtx = unknown>(def: {
  schema: TSchema;
  accessPolicy: (
    ctx: AccessContext<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>>,
  ) => boolean | Promise<boolean>;
}): ResourceDefinition<TSchema, TCtx> {
  return def as ResourceDefinition<TSchema, TCtx>;
}
