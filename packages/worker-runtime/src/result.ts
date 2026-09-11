import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ForbiddenError, TakibiError } from "@takibi/api";
import { SchemaValidationError } from "./schema";
import type { TakibiFailure, TakibiResult, ValidationIssue } from "@takibi/shared-types";

/** Copy only JSON-safe message/path from Standard Schema issues. */
export function normalizeValidationIssues(
  issues: readonly StandardSchemaV1.Issue[],
): ValidationIssue[] {
  return issues.map((issue) => {
    const path = issue.path
      ?.map((segment): string | number | undefined => {
        if (typeof segment === "string") return segment;
        if (typeof segment === "number" && Number.isFinite(segment)) return segment;
        if (segment && typeof segment === "object" && "key" in segment) {
          const key = (segment as { key: PropertyKey }).key;
          if (typeof key === "string") return key;
          if (typeof key === "number" && Number.isFinite(key)) return key;
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

export function toTakibiFailure<TReasonCode extends string>(
  err: ForbiddenError<TReasonCode>,
): TakibiFailure<TReasonCode>;
export function toTakibiFailure(err: SchemaValidationError | TakibiError): TakibiFailure<string>;
export function toTakibiFailure(err: SchemaValidationError | TakibiError): TakibiFailure<string> {
  if (err instanceof SchemaValidationError) {
    return {
      kind: "validation",
      code: "VALIDATION",
      message: err.message,
      status: 400,
      issues: normalizeValidationIssues(err.issues),
    };
  }
  const failure = {
    kind: "operation" as const,
    code: err.code,
    message: err.message,
    status: err.status,
    ...(err instanceof ForbiddenError && err.reason ? { reason: err.reason } : {}),
  };
  return failure;
}

export async function asTakibiResult<T>(fn: () => Promise<T>): Promise<TakibiResult<T, string>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof SchemaValidationError || err instanceof TakibiError) {
      return { ok: false, error: toTakibiFailure(err) };
    }
    throw err;
  }
}
