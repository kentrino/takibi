import type { StandardSchemaV1 } from "@standard-schema/spec";

export type AnySchema = StandardSchemaV1;

export type InferSchemaInput<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;
export type InferSchemaOutput<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

export class SchemaValidationError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map((i) => i.message).join("; ") || "Schema validation failed");
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export async function parseSchema<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<InferSchemaOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    throw new SchemaValidationError(result.issues);
  }
  return result.value as InferSchemaOutput<S>;
}
