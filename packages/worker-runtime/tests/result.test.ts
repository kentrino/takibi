import { ForbiddenError, TakibiError } from "@takibi/api";
import type { TakibiFailure, TakibiResult } from "@takibi/shared-types";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { normalizeInvocationFailure, toWireFailure } from "@takibi/worker-runtime";
import { asTakibiResult, toTakibiFailure } from "@takibi/worker-runtime";
import { SchemaValidationError } from "../src/schema";

test("typed forbidden errors preserve their reason code type", () => {
  const error = new ForbiddenError("Forbidden", { code: "LOCKED_ITEM" });
  const failure = toTakibiFailure(error);

  expectTypeOf(failure).toEqualTypeOf<TakibiFailure<"LOCKED_ITEM">>();
  expect(failure).toEqual({
    kind: "operation",
    code: "FORBIDDEN",
    message: "Forbidden",
    status: 403,
    reason: { code: "LOCKED_ITEM" },
  });
});

test("broad Takibi errors use the string reason boundary", () => {
  const error: TakibiError = new ForbiddenError("Forbidden", { code: "FUTURE_REASON" });
  const failure = toTakibiFailure(error);

  expectTypeOf(failure).toEqualTypeOf<TakibiFailure<string>>();
  function rejectNarrowReason(broadError: TakibiError) {
    // @ts-expect-error A broad error cannot select a narrower reason code.
    return toTakibiFailure<"DECLARED_REASON">(broadError);
  }
  void rejectNarrowReason;
  expect(failure).toMatchObject({
    kind: "operation",
    code: "FORBIDDEN",
    reason: { code: "FUTURE_REASON" },
  });
});

test("asTakibiResult keeps arbitrary thrown reasons at a string boundary", async () => {
  const pending = asTakibiResult(async (): Promise<never> => {
    throw new ForbiddenError("Forbidden", { code: "HANDLER_REASON" });
  });

  expectTypeOf(pending).toEqualTypeOf<Promise<TakibiResult<never, string>>>();
  function rejectReasonParameter() {
    // @ts-expect-error Thrown reason codes are not a selectable type parameter.
    return asTakibiResult<never, "DECLARED_REASON">(async (): Promise<never> => {
      throw new Error("not run");
    });
  }
  void rejectReasonParameter;
  await expect(pending).resolves.toEqual({
    ok: false,
    error: {
      kind: "operation",
      code: "FORBIDDEN",
      message: "Forbidden",
      status: 403,
      reason: { code: "HANDLER_REASON" },
    },
  });
});

test("failure conversion preserves validation and operation envelopes", () => {
  expect(
    toTakibiFailure(new SchemaValidationError([{ message: "Invalid title", path: ["title"] }])),
  ).toEqual({
    kind: "validation",
    code: "VALIDATION",
    message: "Invalid title",
    status: 400,
    issues: [{ message: "Invalid title", path: ["title"] }],
  });

  expect(toTakibiFailure(new TakibiError("CONFLICT", "Conflict", 409))).toEqual({
    kind: "operation",
    code: "CONFLICT",
    message: "Conflict",
    status: 409,
  });
});

test("wire failures mask only unexpected error messages", () => {
  expect(normalizeInvocationFailure(new Error("private storage details"))).toMatchObject({
    code: "INTERNAL",
    message: "An unexpected error occurred.",
    status: 500,
  });

  expect(toWireFailure(new Error("private storage details"))).toEqual({
    ok: false,
    error: {
      kind: "operation",
      code: "INTERNAL",
      message: "An unexpected error occurred.",
      status: 500,
    },
  });

  expect(toWireFailure(new TakibiError("INTERNAL", "Declared public detail", 500))).toEqual({
    ok: false,
    error: {
      kind: "operation",
      code: "INTERNAL",
      message: "Declared public detail",
      status: 500,
    },
  });
});
