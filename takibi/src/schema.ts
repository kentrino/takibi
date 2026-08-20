import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TAKIBI_SPAN } from "./span-vocabulary";
import { withSpan } from "./tracing";

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
): Promise<StandardSchemaV1.InferOutput<S>> {
  return withSpan({ name: TAKIBI_SPAN.schema, kind: "internal" }, async () => {
    const result = await schema["~standard"].validate(value);
    if (result.issues) {
      throw new SchemaValidationError(result.issues);
    }
    return result.value as StandardSchemaV1.InferOutput<S>;
  });
}
