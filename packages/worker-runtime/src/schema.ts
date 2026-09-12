import type { StandardSchemaV1 } from "@standard-schema/spec";
import { withTracing } from "@takibi/utility";
import type { InternalLogger } from "./logging";
import { withLoggedSpan } from "./logging";
import { TAKIBI_SPAN } from "./otel-helper";

export type SchemaSurface = {
  parse: <S extends StandardSchemaV1>(
    schema: S,
    value: unknown,
  ) => Promise<StandardSchemaV1.InferOutput<S>>;
};

export class SchemaValidationError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map((i) => i.message).join("; ") || "Schema validation failed");
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

export async function parseSchemaUnobserved<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new SchemaValidationError(result.issues);
  return result.value as StandardSchemaV1.InferOutput<S>;
}

export class SchemaParser implements SchemaSurface {
  async parse<S extends StandardSchemaV1>(
    schema: S,
    value: unknown,
  ): Promise<StandardSchemaV1.InferOutput<S>> {
    return parseSchemaUnobserved(schema, value);
  }
}

export function traceSchemaParser(
  schema: SchemaParser,
  logger: InternalLogger | undefined,
): SchemaSurface {
  return withTracing(schema, {
    method: "parse",
    span: TAKIBI_SPAN.schema,
    kind: "internal",
    run: (spec, fn) => withLoggedSpan(logger, spec, { event: "takibi.schema" }, fn),
  });
}

export async function parseSchema<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  logger?: InternalLogger,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const parser = traceSchemaParser(new SchemaParser(), logger);
  return parser.parse(schema, value);
}
