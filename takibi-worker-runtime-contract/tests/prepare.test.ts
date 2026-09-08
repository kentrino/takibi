import { expect, test } from "vite-plus/test";
import {
  composeActionPreparation,
  invocationStageResult,
  unwrapInvocationAdapterResult,
} from "../src";
import type { InternalInvocationTypeMap, InvocationAdapterResult } from "../src";

type Spec = InternalInvocationTypeMap & {
  context: { tenantId: string };
  input: { name: string };
};

test("identify updates remain when authorize fails", async () => {
  const result = await composeActionPreparation<Spec, { id: string }, never, never>({
    identify: () => ({
      outcome: "succeeded",
      value: { id: "patient-1" },
      updates: { context: { tenantId: "after-identify" } },
    }),
    authorize: () => ({
      outcome: "failed",
      error: new Error("FORBIDDEN"),
    }),
    parse: () => {
      throw new Error("parse must not run");
    },
  });

  expect(result).toEqual({
    outcome: "failed",
    error: new Error("FORBIDDEN"),
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

test("invocationStageResult keeps the thrown error identity and invents no updates", async () => {
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

test("invocationStageResult records updates only after success", async () => {
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

test("unwrapInvocationAdapterResult rethrows the original failure", () => {
  const error = new Error("PARSE_FAILED");
  try {
    unwrapInvocationAdapterResult<Spec, string>({ outcome: "failed", error });
    expect.unreachable("unwrap must throw");
  } catch (caught) {
    expect(caught).toBe(error);
  }
  expect(unwrapInvocationAdapterResult<Spec, string>({ outcome: "succeeded", value: "ok" })).toBe(
    "ok",
  );
});

test("undefined later updates do not erase completed preparation", async () => {
  const result = await composeActionPreparation<Spec, string, string, string>({
    identify: () => ({
      outcome: "succeeded",
      value: "identified",
      updates: { context: { tenantId: "after-identify" }, input: { status: "raw", value: "Ada" } },
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
