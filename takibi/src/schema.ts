import type { StandardSchemaV1 } from "@standard-schema/spec";
import { withLoggedSpan, type InternalLogger } from "./logging";
import { TAKIBI_SPAN } from "./otel-helper";

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
  logger?: InternalLogger,
): Promise<StandardSchemaV1.InferOutput<S>> {
  return withLoggedSpan(
    logger,
    { name: TAKIBI_SPAN.schema, kind: "internal" },
    { event: "takibi.schema" },
    async () => {
      const result = await schema["~standard"].validate(value);
      if (result.issues) {
        throw new SchemaValidationError(result.issues);
      }
      return result.value as StandardSchemaV1.InferOutput<S>;
    },
  );
}

export async function parseSchemaUnobserved<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new SchemaValidationError(result.issues);
  return result.value as StandardSchemaV1.InferOutput<S>;
}
