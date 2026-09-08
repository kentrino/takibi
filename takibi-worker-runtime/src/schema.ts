import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createClass } from "@takibi/takibi-utility";
import type { InternalLogger } from "./logging";
import { otel } from "./otel";
import { TAKIBI_SPAN } from "./otel-helper";

export type SchemaSurface = {
  parse: (schema: StandardSchemaV1, value: unknown) => Promise<unknown>;
};

export type SchemaParserCtor = {
  readonly logger?: InternalLogger;
};

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
  const parser = SchemaParser.newWithInterceptors(
    { logger },
    otel(logger, {
      parse: { name: TAKIBI_SPAN.schema, kind: "internal", event: "takibi.schema" },
    }),
  );
  return parser.parse(schema, value) as Promise<StandardSchemaV1.InferOutput<S>>;
}

export async function parseSchemaUnobserved<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new SchemaValidationError(result.issues);
  return result.value as StandardSchemaV1.InferOutput<S>;
}

export const SchemaParser = createClass<SchemaSurface>()
  .constructor<SchemaParserCtor>({
    runtimeCheck: true,
  })
  .define("parse", (_deps, schema, value) => parseSchemaUnobserved(schema, value));
