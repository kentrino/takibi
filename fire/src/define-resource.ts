import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AccessPolicy, ResourceDefinition, WithMetadata } from "./types";

/**
 * Define a reusable resource while keeping `accessPolicy` and `seed` tied to
 * the concrete schema.
 */
export function defineResource<TSchema extends StandardSchemaV1, TCtx = unknown>(def: {
  schema: TSchema;
  accessPolicy: AccessPolicy<TCtx, WithMetadata<StandardSchemaV1.InferOutput<TSchema>>>;
  seed?: ResourceDefinition<TSchema, TCtx>["seed"];
}): ResourceDefinition<TSchema, TCtx> {
  return def as ResourceDefinition<TSchema, TCtx>;
}
