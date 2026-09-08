import { expect, expectTypeOf, test } from "vite-plus/test";
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
} from "../src";

type Spec = {
  wireInvocation: { kind: "action"; input: unknown };
  invocation: { kind: "action" };
  collections: { names: string[] };
  storage: { scope: "base" | "transaction" };
  registry: { name: string };
  context: { tenantId: string };
  logger: undefined;
  services: { audit: string[] };
  rawInput: unknown;
  input: { name: string };
  noneWork: { key: string };
  applyWork: { key: string };
  fullWork: { key: string };
  nonePrepared: Record<string, never>;
  applyPrepared: Record<string, never>;
  result: { id: string; nested?: { value: string } };
  failure: { code: string };
};

const request: InvocationRequest<Spec> = {
  wireInvocation: { kind: "action", input: { name: "Ada" } },
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
    invocationToInvocation: () => ({ kind: "action" }),
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
      prepareAndApply: () => ({ outcome: "failed", error: new Error("unexpected") }),
    },
    transactionRun: undefined,
    transactionClassifyFailure: undefined,
    invocationToFailure: (error) => ({
      code: error instanceof Error ? error.message : "INTERNAL",
    }),
    invocationSnapshotObserverEvent(event) {
      const { services, ...detachable } = event;
      return { ...structuredClone(detachable), services } as InvocationObserverEvent<Spec>;
    },
    invocationNotify: undefined,
    ...overrides,
  };
}

function initialize(state: InvocationState<Spec>): void {
  state.start();
  state.acceptInvocation({ kind: "action" });
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
  state.acceptInvocation({ kind: "action" });
  expect(() => state.acceptInvocation({ kind: "action" })).toThrow(TakibiContractStateError);
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
  expect(observed?.inputAvailable).toBe(true);
  expect(observed?.input).toEqual({ name: "Ada" });
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
        if (event.outcome !== "succeeded" || event.result.nested === undefined) return;
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
  expect(result.settlement).toEqual({
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
  unchecked.acceptInvocation({ kind: "action" });
  expect(() => unchecked.acceptInvocation({ kind: "action" })).toThrow(TakibiContractStateError);
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
    invocationToFailure: () =>
      ({ code: "HANDLER_FAILED", details: { reason: "original" } }) as never,
    invocationNotify: (event) => {
      if (
        event.outcome === "failed" &&
        event.failure.kind === "mapped" &&
        "details" in event.failure.value
      ) {
        (event.failure.value.details as { reason: string }).reason = "mutated";
      }
    },
  });

  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { details: { reason: "original" } } },
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
  state.fail("execute", { kind: "mapped", value: { code: "FAILED" } });
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

  expect(result.invocation).toEqual({ kind: "action" });
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
      prepareAndApply: (_view, work, storage) => {
        expect(work.key).toBe("work");
        expect(storage.scope).toBe("transaction");
        events.push("prepare-and-apply");
        return { outcome: "succeeded", value: { id: "patient-1" } };
      },
    },
  });

  expect(events).toEqual(["transaction", "prepare-and-apply"]);
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
