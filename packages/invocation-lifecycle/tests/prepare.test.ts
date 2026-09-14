import { expect, test } from "vite-plus/test";
import {
  invocationStageResult,
  mergeInvocationUpdates,
  unwrapInvocationAdapterResult,
  type InternalInvocationTypeMap,
} from "@takibi/invocation-lifecycle";

type Spec = InternalInvocationTypeMap & {
  runtime: { storage: unknown };
  context: { tenantId: string };
  input: { name: string };
};

test("invocationStageResult preserves thrown error identity", async () => {
  const error = new Error("AUTHORIZE_FAILED");
  const result = await invocationStageResult<Spec, never>(
    () => {
      throw error;
    },
    () => ({ context: { tenantId: "must-not-record" } }),
  );
  expect(result).toEqual({ outcome: "failed", error });
  expect(result.outcome === "failed" && result.error).toBe(error);
});

test("invocationStageResult records updates after success", async () => {
  const result = await invocationStageResult<Spec, { id: string }>(
    () => ({ id: "patient-1" }),
    () => ({ context: { tenantId: "after-identify" } }),
  );
  expect(result).toEqual({
    outcome: "succeeded",
    value: { id: "patient-1" },
    updates: { context: { tenantId: "after-identify" } },
  });
});

test("mergeInvocationUpdates does not erase earlier explicit updates", () => {
  expect(
    mergeInvocationUpdates<Spec>(
      {
        context: { tenantId: "after-identify" },
        input: { status: "raw", value: "Ada" },
      },
      { context: undefined, input: undefined },
    ),
  ).toEqual({
    context: { tenantId: "after-identify" },
    input: { status: "raw", value: "Ada" },
  });
});

test("unwrapInvocationAdapterResult rethrows the original failure", () => {
  const error = new Error("PARSE_FAILED");
  expect(() => unwrapInvocationAdapterResult<Spec, string>({ outcome: "failed", error })).toThrow(
    error,
  );
  expect(unwrapInvocationAdapterResult<Spec, string>({ outcome: "succeeded", value: "ok" })).toBe(
    "ok",
  );
});
