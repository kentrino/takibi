import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TakibiError } from "./errors";
import { SchemaValidationError } from "./schema";
import type { TakibiFailure, TakibiResult, ValidationIssue } from "./types";

/** Copy only JSON-safe message/path from Standard Schema issues. */
export function normalizeValidationIssues(
  issues: readonly StandardSchemaV1.Issue[],
): ValidationIssue[] {
  return issues.map((issue) => {
    const path = issue.path
      ?.map((segment): string | number | undefined => {
        if (typeof segment === "string" || typeof segment === "number") return segment;
        if (segment && typeof segment === "object" && "key" in segment) {
          const key = (segment as { key: PropertyKey }).key;
          if (typeof key === "string" || typeof key === "number") return key;
        }
        return undefined;
      })
      .filter((segment): segment is string | number => segment !== undefined);

    return {
      message: issue.message,
      ...(path && path.length > 0 ? { path } : {}),
    };
  });
}

export function toTakibiFailure(err: SchemaValidationError | TakibiError): TakibiFailure {
  if (err instanceof SchemaValidationError) {
    return {
      kind: "validation",
      code: "VALIDATION",
      message: err.message,
      status: 400,
      issues: normalizeValidationIssues(err.issues),
    };
  }
  return {
    kind: "operation",
    code: err.code,
    message: err.message,
    status: err.status,
  };
}

export async function asTakibiResult<T>(fn: () => Promise<T>): Promise<TakibiResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof SchemaValidationError || err instanceof TakibiError) {
      return { ok: false, error: toTakibiFailure(err) };
    }
    throw err;
  }
}
