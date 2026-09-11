import { expect, expectTypeOf, test } from "vite-plus/test";
import type {
  ActionRequestData,
  ObserverActionRequestData,
  TakibiFailure,
} from "@takibi/shared-types";
import {
  InvocationState,
  runInvocation,
  TakibiContractStateError,
  type InternalInvocationSettledTransaction,
  type InvocationAdapters,
  type InvocationObserverEvent,
  type InvocationPlan,
  type InvocationRequest,
  type InvocationResult,
  type TransactionBoundary,
} from "@takibi/worker-runtime-contract";

type Spec = {
  wireInvocation: ActionRequestData;
  invocation: ObserverActionRequestData;
  runtime: {
    collections: { names: string[] };
    storage: { scope: "base" | "transaction" };
    registry: { name: string };
    logger: undefined;
    services: { audit: string[] };
  };
  context: { tenantId: string };
  rawInput: unknown;
  input: { name: string };
  noneWork: { key: string };
  applyWork: { key: string };
  fullWork: { key: string };
  nonePrepared: Record<string, never>;
  applyPrepared: Record<string, never>;
  fullPrepared: Record<string, never>;
  result: { id: string } | { id: string; nested: { value: string } };
  failure: TakibiFailure<string>;
};

const publicInvocation: ObserverActionRequestData = {
  kind: "action",
  scope: "patients",
  name: "register",
};

const request: InvocationRequest<Spec> = {
  wireInvocation: { ...publicInvocation, input: { name: "Ada" } },
  context: { tenantId: "before" },
};

const runtime: InvocationAdapters<Spec>["invocationRuntime"] = {
  collections: { names: ["patients"] },
  storage: { scope: "base" },
  registry: { name: "actions" },
  logger: undefined,
  services: { audit: [] },
};

function adapters(overrides: Partial<InvocationAdapters<Spec>> = {}): InvocationAdapters<Spec> {
  return {
    invocationRuntime: runtime,
    invocationToInvocation: () => publicInvocation,
    invocationGetRawInput: (wire) => wire.input,
    invocationCreatePlan: () => ({
      outcome: "succeeded",
      value: { transactionBoundary: "none", work: { key: "work" } },
    }),
    transactionNone: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "succeeded", value: { id: "patient-1" } }),
    },
    transactionApply: {
      prepare: () => ({ outcome: "failed", error: new Error("unexpected") }),
      apply: () => ({ outcome: "failed", error: new Error("unexpected") }),
    },
    transactionFull: {
      prepare: () => ({ outcome: "failed", error: new Error("unexpected") }),
      apply: () => ({ outcome: "failed", error: new Error("unexpected") }),
    },
    transactionRun: undefined,
    transactionClassifyFailure: undefined,
    invocationToFailure: (error) => ({
      kind: "operation",
      code: error instanceof Error ? error.message : "INTERNAL",
      message: error instanceof Error ? error.message : "INTERNAL",
      status: 500,
    }),
    invocationSnapshotObserverEvent(event) {
      return structuredClone(event);
    },
    invocationNotify: undefined,
    ...overrides,
  };
}

function initialize(state: InvocationState<Spec>): void {
  state.start();
  state.acceptInvocation(publicInvocation);
  state.acceptRawInput({ name: "Ada" });
  state.acceptPlan({
    outcome: "succeeded",
    value: { transactionBoundary: "none", work: { key: "work" } },
  });
}

function runWith(
  transactionBoundary: TransactionBoundary,
  overrides: Partial<InvocationAdapters<Spec>> = {},
  runtimeChecks?: boolean,
) {
  const createPlan = () => ({
    outcome: "succeeded" as const,
    value:
      transactionBoundary === "none"
        ? ({ transactionBoundary, work: { key: "work" } } as const)
        : transactionBoundary === "apply"
          ? ({ transactionBoundary, work: { key: "work" } } as const)
          : ({ transactionBoundary, work: { key: "work" } } as const),
  });
  return runInvocation(adapters({ invocationCreatePlan: createPlan, ...overrides }), {
    request,
    invocationRuntimeChecks: runtimeChecks,
  });
}

test("state uses one instance and rejects illegal or duplicate transitions", () => {
  const state = new InvocationState(request, runtime);
  expect(() => state.planningView()).toThrow(TakibiContractStateError);
  state.start();
  expect(() => state.start()).toThrow(TakibiContractStateError);
  state.acceptInvocation(publicInvocation);
  expect(() => state.acceptInvocation(publicInvocation)).toThrow(TakibiContractStateError);
  state.acceptPlan({
    outcome: "succeeded",
    value: { transactionBoundary: "none", work: { key: "work" } },
  });
  expect(() =>
    state.acceptPlan({
      outcome: "succeeded",
      value: { transactionBoundary: "none", work: { key: "work" } },
    }),
  ).toThrow(TakibiContractStateError);
  state.succeed({ id: "patient-1" });
  expect(() => state.succeed({ id: "patient-2" })).toThrow(TakibiContractStateError);
});

test("adapter views are shallow projections without carrier mutation fields", () => {
  const state = new InvocationState(request, runtime);
  initialize(state);
  const view = state.executionView();

  expect(view).not.toBe(state);
  expect(view).not.toHaveProperty("phase");
  expect(view).not.toHaveProperty("effects");
  expect(view).not.toHaveProperty("settlement");
  expect(view).not.toHaveProperty("notification");
  expect(view.runtime).not.toHaveProperty("storage");
  expectTypeOf(view).not.toHaveProperty("phase");
  expectTypeOf(view).not.toHaveProperty("effects");
  expectTypeOf(view).not.toHaveProperty("settlement");
});

test("replacing fields on an adapter view cannot change carrier fields", () => {
  const state = new InvocationState(request, runtime);
  initialize(state);
  const view = state.executionView();
  const mutableView = view as {
    context: Spec["context"];
    input: typeof view.input;
  };
  mutableView.context = { tenantId: "view-only" };
  mutableView.input = { status: "rejected" };

  expect(state.executionView().context).toEqual({ tenantId: "before" });
  expect(state.executionView().input).toEqual({
    status: "raw",
    value: { name: "Ada" },
  });
});

test("context update remains visible when a later adapter step fails", async () => {
  let observed: InvocationObserverEvent<Spec> | undefined;
  const result = await runInvocation(
    adapters({
      transactionNone: {
        prepare: () => ({
          outcome: "failed",
          error: new Error("GATE_FAILED"),
          updates: { context: { tenantId: "after-guard" } },
        }),
        apply: () => ({ outcome: "failed", error: new Error("unexpected") }),
      },
      invocationNotify: (event) => {
        observed = event;
      },
    }),
    { request },
  );

  expect(result.context).toEqual({ tenantId: "after-guard" });
  expect(observed?.context).toEqual({ tenantId: "after-guard" });
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { code: "GATE_FAILED" } },
  });
});

test("observer uses construction-bound services and the event has none", async () => {
  const services = { audit: [] as string[] };
  let observedKeys: string[] | undefined;
  const result = await runInvocation(
    adapters({
      invocationRuntime: { ...runtime, services },
      invocationNotify: (event) => {
        observedKeys = Object.keys(event);
        services.audit.push(`${event.context.tenantId}:${event.outcome}`);
      },
    }),
    { request },
  );

  expect(observedKeys).toBeDefined();
  expect(observedKeys).not.toContain("services");
  expect(result.runtime.services).toBe(services);
  expect(services.audit).toEqual(["before:succeeded"]);
});

test("observer event exposes only validated input and never raw input", async () => {
  let observed: InvocationObserverEvent<Spec> | undefined;
  const result = await runInvocation(
    adapters({
      invocationNotify: (event) => {
        observed = event;
      },
    }),
    { request },
  );

  expect(result.input).toEqual({ status: "raw", value: { name: "Ada" } });
  expect(observed?.input).toEqual({ status: "unavailable" });
  expect(observed).not.toHaveProperty("inputAvailable");
  expect(JSON.stringify(observed)).not.toContain("Ada");
  expect(observed?.invocation).toEqual(publicInvocation);
  expect(observed?.invocation).not.toHaveProperty("input");
});

test("validated undefined input is distinct from unavailable", () => {
  type OptionalInputSpec = Omit<Spec, "input"> & { input: { name: string } | undefined };
  const state = new InvocationState<OptionalInputSpec>(request, runtime);
  state.start();
  state.acceptInvocation(publicInvocation);
  state.acceptRawInput({ name: "Ada" });
  state.acceptPlan({
    outcome: "succeeded",
    value: { transactionBoundary: "none", work: { key: "work" } },
  });
  state.acceptAdapterResult({
    outcome: "succeeded",
    value: { id: "patient-1" },
    updates: { input: { status: "validated", value: undefined } },
  });
  state.succeed({ id: "patient-1" });

  expect(state.observerEvent().input).toEqual({ status: "validated", value: undefined });
});

test("validated input update remains visible when the handler later fails", async () => {
  let observed: InvocationObserverEvent<Spec> | undefined;
  const result = await runInvocation(
    adapters({
      transactionNone: {
        prepare: () => ({ outcome: "succeeded", value: {} }),
        apply: () => ({
          outcome: "failed",
          error: new Error("HANDLER_FAILED"),
          updates: { input: { status: "validated", value: { name: "Ada" } } },
        }),
      },
      invocationNotify: (event) => {
        observed = event;
      },
    }),
    { request },
  );

  expect(result.input).toEqual({ status: "validated", value: { name: "Ada" } });
  expect(observed?.input).toEqual({ status: "validated", value: { name: "Ada" } });
});

test("notification failure cannot alter settlement", async () => {
  const result = await runInvocation(
    adapters({
      transactionNone: {
        prepare: () => ({ outcome: "succeeded", value: {} }),
        apply: () => ({
          outcome: "succeeded",
          value: { id: "patient-1", nested: { value: "original" } },
        }),
      },
      invocationNotify: (event) => {
        if (
          event.outcome !== "succeeded" ||
          !("nested" in event.result) ||
          event.result.nested === undefined
        ) {
          return;
        }
        event.result.nested.value = "observer";
        throw new Error("OBSERVER_FAILED");
      },
    }),
    { request },
  );

  expect(result.settlement).toEqual({
    outcome: "succeeded",
    result: { id: "patient-1", nested: { value: "original" } },
  });
  expect(result.notification).toMatchObject({ outcome: "failed" });
});

test("transaction outcome stays separate from settlement", async () => {
  const events: string[] = [];
  const result = await runInvocation(
    adapters({
      invocationCreatePlan: () => ({
        outcome: "succeeded",
        value: { transactionBoundary: "apply", work: { key: "work" } },
      }),
      transactionRun: async (work) => {
        events.push("transaction");
        return work({ scope: "transaction" });
      },
      transactionApply: {
        prepare: () => ({ outcome: "succeeded", value: {} }),
        apply: (_view, _prepared, storage) => {
          expect(storage.scope).toBe("transaction");
          events.push("apply");
          return { outcome: "succeeded", value: { id: "patient-1" } };
        },
      },
    }),
    { request },
  );

  expect(events).toEqual(["transaction", "apply"]);
  expect(result.effects.transaction).toBe("committed");
});

test("result and adapter views expose only their owned readonly contract", () => {
  type ApplyView = Parameters<InvocationAdapters<Spec>["transactionApply"]["apply"]>[0];
  type Plan = InvocationPlan<Spec>;

  expectTypeOf<ApplyView>().not.toHaveProperty("wireInvocation");
  expectTypeOf<ApplyView["runtime"]>().not.toHaveProperty("storage");
  expectTypeOf<Extract<Plan, { transactionBoundary: "none" }>["work"]>().toEqualTypeOf<
    Spec["noneWork"]
  >();
  expectTypeOf<
    InvocationResult<Spec>["effects"]["transaction"]
  >().toEqualTypeOf<InternalInvocationSettledTransaction>();
});

test("transactional execution failure is mapped and leaves outcome unknown", async () => {
  let observerCalls = 0;
  const result = await runWith("apply", {
    transactionRun: async (work) => work({ scope: "transaction" }),
    transactionApply: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "failed", error: new Error("HANDLER_FAILED") }),
    },
    invocationNotify: () => {
      observerCalls += 1;
    },
  });

  expect(observerCalls).toBe(1);
  expect(result.effects.transaction).toBe("unknown");
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    stage: "execute",
    failure: { kind: "mapped", value: { code: "HANDLER_FAILED" } },
  });
});

test("a transaction commit failure is classified separately", async () => {
  const result = await runWith("apply", {
    transactionRun: async (work) => {
      await work({ scope: "transaction" });
      throw new Error("COMMIT_FAILED");
    },
    transactionApply: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "succeeded", value: { id: "patient-1" } }),
    },
  });

  expect(result.effects.transaction).toBe("unknown");
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    stage: "commit",
    failure: { kind: "mapped", value: { code: "COMMIT_FAILED" } },
  });
});

test("a throwing failure mapper remains observable", async () => {
  let observed: InvocationObserverEvent<Spec> | undefined;
  const result = await runWith("none", {
    transactionNone: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "failed", error: new Error("HANDLER_FAILED") }),
    },
    invocationToFailure: () => {
      throw new Error("MAPPER_FAILED");
    },
    invocationNotify: (event) => {
      observed = event;
    },
  });

  expect(observed?.outcome).toBe("failed");
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapping-failed", error: new Error("MAPPER_FAILED") },
  });
});

test("runtimeChecks controls phase checks without disabling slot integrity", () => {
  const checked = new InvocationState(request, runtime, true);
  checked.start();
  expect(() => checked.start()).toThrow(TakibiContractStateError);

  const unchecked = new InvocationState(request, runtime, false);
  unchecked.start();
  expect(() => unchecked.start()).not.toThrow();
  unchecked.acceptInvocation(publicInvocation);
  expect(() => unchecked.acceptInvocation(publicInvocation)).toThrow(TakibiContractStateError);
});

test("notification remains single-shot when runtimeChecks is disabled", () => {
  const state = new InvocationState(request, runtime, false);
  initialize(state);
  state.succeed({ id: "patient-1" });
  expect(state.beginNotification()).toBe(true);
  state.finishNotification({ outcome: "skipped" });
  const first = state.result();

  expect(state.beginNotification()).toBe(false);
  expect(state.result()).toStrictEqual(first);
});

test("notification snapshot failure does not change settlement", async () => {
  const snapshotError = new Error("SNAPSHOT_FAILED");
  let observerCalls = 0;
  const result = await runWith("none", {
    transactionNone: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "succeeded", value: { id: "patient-1" } }),
    },
    invocationSnapshotObserverEvent: () => {
      throw snapshotError;
    },
    invocationNotify: () => {
      observerCalls += 1;
    },
  });

  expect(observerCalls).toBe(0);
  expect(result.settlement).toEqual({
    outcome: "succeeded",
    result: { id: "patient-1" },
  });
  expect(result.notification).toEqual({ outcome: "failed", error: snapshotError });
});

test("observer mutation of a mapped failure cannot alter settlement", async () => {
  const result = await runWith("none", {
    transactionNone: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "failed", error: new Error("HANDLER_FAILED") }),
    },
    invocationToFailure: () => ({
      kind: "operation",
      code: "HANDLER_FAILED",
      message: "original",
      status: 500,
    }),
    invocationNotify: (event) => {
      if (event.outcome === "failed" && event.failure.kind === "mapped") {
        event.failure.value.message = "mutated";
      }
    },
  });

  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "original" } },
  });
});

test("a detached write can fail before opening a transaction", async () => {
  let transactions = 0;
  const result = await runWith("apply", {
    transactionRun: async (work) => {
      transactions += 1;
      return work({ scope: "transaction" });
    },
    transactionApply: {
      prepare: () => ({ outcome: "failed", error: new Error("FORBIDDEN") }),
      apply: () => ({ outcome: "failed", error: new Error("unexpected") }),
    },
  });

  expect(transactions).toBe(0);
  expect(result.effects.transaction).toBe("none");
  expect(result.settlement).toMatchObject({ outcome: "failed", stage: "execute" });
});

test("none-boundary writes do not imply an invocation transaction", async () => {
  let writes = 0;
  const result = await runWith("none", {
    transactionNone: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => {
        writes += 1;
        return { outcome: "succeeded", value: { id: "patient-1" } };
      },
    },
  });

  expect(writes).toBe(1);
  expect(result.effects.transaction).toBe("none");
});

test("settlement normalizes an unexpectedly open transaction", () => {
  const state = new InvocationState(request, runtime);
  initialize(state);
  state.beginTransaction();
  state.fail("execute", {
    kind: "mapped",
    value: { kind: "operation", code: "FAILED", message: "FAILED", status: 500 },
  });
  const event = state.observerEvent();

  expect(event.transaction).toBe("unknown");
});

test("wire projection failure has explicit unavailable terminal fields", async () => {
  let observed: InvocationObserverEvent<Spec> | undefined;
  const result = await runWith("none", {
    invocationToInvocation: () => {
      throw new Error("INVALID_WIRE");
    },
    invocationNotify: (event) => {
      observed = event;
    },
  });

  expect(result.invocation).toBeUndefined();
  expect(result.plan).toBeUndefined();
  expect(observed?.invocation).toBeUndefined();
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    stage: "classify",
    failure: { kind: "mapped", value: { code: "INVALID_WIRE" } },
  });
});

test("plan-creation failure preserves initialized invocation but no plan", async () => {
  const result = await runWith("none", {
    invocationCreatePlan: () => ({
      outcome: "failed",
      error: new Error("UNKNOWN_OPERATION"),
    }),
  });

  expect(result.invocation).toEqual(publicInvocation);
  expect(result.plan).toBeUndefined();
});

test("rollback failure classification leaves transaction unknown", async () => {
  const result = await runWith("apply", {
    transactionRun: async (work) => work({ scope: "transaction" }),
    transactionClassifyFailure: () => ({ stage: "rollback", transaction: "unknown" }),
    transactionApply: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "failed", error: new Error("HANDLER_FAILED") }),
    },
  });

  expect(result.effects.transaction).toBe("unknown");
  expect(result.settlement).toMatchObject({ outcome: "failed", stage: "rollback" });
});

test("only adapter confirmation reports a rolled-back transaction", async () => {
  const result = await runWith("apply", {
    transactionRun: async (work) => work({ scope: "transaction" }),
    transactionClassifyFailure: () => ({ stage: "execute", transaction: "rolled-back" }),
    transactionApply: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "failed", error: new Error("HANDLER_FAILED") }),
    },
  });

  expect(result.effects.transaction).toBe("rolled-back");
});

test("full boundary prepares and applies inside the transaction", async () => {
  const events: string[] = [];
  const result = await runWith("full", {
    transactionRun: async (work) => {
      events.push("transaction");
      return work({ scope: "transaction" });
    },
    transactionFull: {
      prepare: (_view, work, storage) => {
        expect(work.key).toBe("work");
        expect(storage.scope).toBe("transaction");
        events.push("prepare");
        return { outcome: "succeeded", value: {} };
      },
      apply: (_view, _prepared, storage) => {
        expect(storage.scope).toBe("transaction");
        events.push("apply");
        return { outcome: "succeeded", value: { id: "patient-1" } };
      },
    },
  });

  expect(events).toEqual(["transaction", "prepare", "apply"]);
  expect(result.plan?.transactionBoundary).toBe("full");
  expect(result.effects.transaction).toBe("committed");
});

test("apply boundary prepares before entering its transaction", async () => {
  const events: string[] = [];
  await runWith("apply", {
    transactionRun: async (work) => {
      events.push("transaction");
      return work({ scope: "transaction" });
    },
    transactionApply: {
      prepare: () => {
        events.push("prepare");
        return { outcome: "succeeded", value: {} };
      },
      apply: () => {
        events.push("apply");
        return { outcome: "succeeded", value: { id: "patient-1" } };
      },
    },
  });

  expect(events).toEqual(["prepare", "transaction", "apply"]);
});

test("missing transaction wiring is a configuration failure", async () => {
  const result = await runWith("apply", {
    transactionApply: {
      prepare: () => ({ outcome: "succeeded", value: {} }),
      apply: () => ({ outcome: "succeeded", value: { id: "patient-1" } }),
    },
  });

  expect(result.settlement).toMatchObject({
    outcome: "failed",
    stage: "execute",
    failure: { kind: "configuration" },
  });
});

test("notification cannot begin from a running state even without runtime checks", () => {
  const state = new InvocationState(request, runtime, false);
  state.start();
  expect(() => state.beginNotification()).toThrow(TakibiContractStateError);
});

test("terminal DTO is shallow-frozen without freezing payloads", async () => {
  const result = await runWith("none");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.context)).toBe(false);
});

test("undefined update fields preserve context and input through failure settlement", () => {
  const state = new InvocationState<Spec>(request, runtime);
  state.start();
  state.acceptInvocation(publicInvocation);
  state.acceptRawInput({ name: "Ada" });
  const error = new Error("plan failed");
  expect(() =>
    state.acceptPlan({
      outcome: "failed",
      error,
      updates: { context: undefined, input: undefined },
    }),
  ).toThrow(error);
  expect(state.planningView().context).toEqual(request.context);
  expect(state.planningView().input).toEqual({ status: "raw", value: { name: "Ada" } });
});

test("settlement and observation preserve an execution value before response conversion", () => {
  type DateSpec = Omit<Spec, "result"> & { result: Date };
  const value = new Date("2026-01-01T00:00:00Z");
  const state = new InvocationState<DateSpec>({ ...request }, runtime);
  state.start();
  state.acceptInvocation(publicInvocation);
  state.acceptPlan({
    outcome: "succeeded",
    value: { transactionBoundary: "none", work: { key: "work" } },
  });
  state.succeed(value);
  const event = state.observerEvent();
  if (event.outcome !== "succeeded") throw new Error("expected success");
  expectTypeOf(event.result).toEqualTypeOf<Date>();
  expect(event.result).toBe(value);
});
