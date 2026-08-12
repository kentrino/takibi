import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AccessContext, ResourceDefinition, WithMetadata } from "./types";

/**
 * Define a reusable resource while keeping `accessPolicy` and `seed` tied to
 * the concrete schema.
 */
export function defineResource<TSchema extends StandardSchemaV1, TCtx = unknown>(def: {
  schema: TSchema;
  accessPolicy: (
    ctx: AccessContext<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>>,
  ) => boolean | Promise<boolean>;
  seed?: ResourceDefinition<TSchema, TCtx>["seed"];
}): ResourceDefinition<TSchema, TCtx> {
  return def as ResourceDefinition<TSchema, TCtx>;
}
