import { expect, test } from "vite-plus/test";
import type {
  InternalInvocationTypeMap,
  InvocationAdapterResult,
} from "@takibi/invocation-lifecycle";
import { composeActionPreparation } from "../src/invocation-prepare-apply";

type Spec = InternalInvocationTypeMap & {
  runtime: { storage: unknown };
  context: { tenantId: string };
  input: { name: string };
};

test("identify updates remain when authorization fails", async () => {
  const error = new Error("FORBIDDEN");
  const result = await composeActionPreparation<Spec, { id: string }, never, never>({
    identify: () => ({
      outcome: "succeeded",
      value: { id: "patient-1" },
      updates: { context: { tenantId: "after-identify" } },
    }),
    authorize: () => ({ outcome: "failed", error }),
    parse: () => {
      throw new Error("parse must not run");
    },
  });

  expect(result).toEqual({
    outcome: "failed",
    error,
    updates: { context: { tenantId: "after-identify" } },
  });
});

test("parse updates merge with earlier context updates", async () => {
  const result: InvocationAdapterResult<Spec, { input: string }> = await composeActionPreparation<
    Spec,
    { id: string },
    { id: string },
    { input: string }
  >({
    identify: () => ({
      outcome: "succeeded",
      value: { id: "patient-1" },
      updates: { context: { tenantId: "after-identify" } },
    }),
    authorize: (identified) => ({ outcome: "succeeded", value: identified }),
    parse: () => ({
      outcome: "succeeded",
      value: { input: "Ada" },
      updates: { input: { status: "validated", value: { name: "Ada" } } },
    }),
  });

  expect(result).toEqual({
    outcome: "succeeded",
    value: { input: "Ada" },
    updates: {
      context: { tenantId: "after-identify" },
      input: { status: "validated", value: { name: "Ada" } },
    },
  });
});

test("undefined later updates do not erase earlier preparation", async () => {
  const result = await composeActionPreparation<Spec, string, string, string>({
    identify: () => ({
      outcome: "succeeded",
      value: "identified",
      updates: {
        context: { tenantId: "after-identify" },
        input: { status: "raw", value: "Ada" },
      },
    }),
    authorize: () => ({
      outcome: "succeeded",
      value: "authorized",
      updates: { context: undefined, input: undefined },
    }),
    parse: () => ({ outcome: "failed", error: "parse failed" }),
  });

  expect(result.updates).toEqual({
    context: { tenantId: "after-identify" },
    input: { status: "raw", value: "Ada" },
  });
});
