import { expect, expectTypeOf, test } from "vite-plus/test";
import type { TakibiFailure } from "@takibi/shared-types";
import {
  runInvocation,
  type BoundRunInvocation,
  type InternalInvocationTypeMap,
  type InvocationAdapters,
  type InvocationAdapterResult,
  type InvocationPlan,
  type InvocationPlanningView,
  type InvocationResult,
} from "@takibi/invocation-lifecycle";
import { createBatchTakibiCall, createSingleTakibiCall } from "../src/envelope/invocation";

type ActionWire = {
  readonly kind: "action";
  readonly scope: string;
  readonly name: string;
  readonly input: unknown;
};
type ActionInvocation = Omit<ActionWire, "input">;

type ReadWire = {
  readonly kind: "collection";
  readonly collection: string;
  readonly operation: "get";
  readonly id: string;
};
type ReadInvocation = ReadWire;

type SingleDecoded = { readonly kind: "single"; readonly wireInvocation: ActionWire };
type BatchDecoded = { readonly kind: "batch"; readonly items: readonly ReadWire[] };

type AppContext = { readonly tenantId: string };
type Collections = { readonly names: readonly string[] };
type Storage = { readonly scope: "base" | "transaction" };
type Registry = { readonly name: "actions" };
type Services = { readonly audit: string[] };
type Failure = TakibiFailure<string>;
type ActionOperation = { readonly key: "action:register" };
type ReadOperation = { readonly key: "collection:get" };
type ActionWork = { readonly operation: ActionOperation };
type ReadWork = { readonly operation: ReadOperation; readonly id: string };
type WireResult<TResult> =
  | { readonly ok: true; readonly data: TResult }
  | { readonly ok: false; readonly error: Failure };

type ActionSpec = {
  wireInvocation: ActionWire;
  invocation: ActionInvocation;
  runtime: {
    collections: Collections;
    storage: Storage;
    registry: Registry;
    logger: undefined;
    services: Services;
  };
  context: AppContext;
  rawInput: unknown;
  input: { displayName: string };
  noneWork: ActionWork;
  applyWork: ActionWork;
  fullWork: ActionWork;
  nonePrepared: Record<string, never>;
  applyPrepared: Record<string, never>;
  fullPrepared: Record<string, never>;
  result: { id: string };
  failure: Failure;
};

type ReadSpec = {
  wireInvocation: ReadWire;
  invocation: ReadInvocation;
  runtime: {
    collections: Collections;
    storage: Storage;
    registry: Registry;
    logger: undefined;
    services: Services;
  };
  context: AppContext;
  rawInput: never;
  input: never;
  noneWork: ReadWork;
  applyWork: ReadWork;
  fullWork: ReadWork;
  nonePrepared: { readonly id?: string };
  applyPrepared: { readonly id?: string };
  fullPrepared: { readonly id?: string };
  result: { id: string };
  failure: Failure;
};

function toFailure(error: unknown): Failure {
  return {
    kind: "operation",
    code: error instanceof Error ? error.message : "INTERNAL",
    message: error instanceof Error ? error.message : "INTERNAL",
    status: 500,
  };
}

function snapshotObserverEvent<T extends InternalInvocationTypeMap>(
  event: import("@takibi/invocation-lifecycle").InvocationObserverEvent<T>,
): import("@takibi/invocation-lifecycle").InvocationObserverEvent<T> {
  return structuredClone(event);
}

function toWireResult<T extends InternalInvocationTypeMap & { failure: Failure }>(
  state: InvocationResult<T>,
): WireResult<T["result"]> {
  return state.settlement.outcome === "succeeded"
    ? { ok: true, data: state.settlement.result }
    : {
        ok: false,
        error:
          state.settlement.failure.kind === "mapped"
            ? state.settlement.failure.value
            : {
                kind: "operation",
                code: "FAILURE_MAPPING",
                message: "FAILURE_MAPPING",
                status: 500,
              },
      };
}

function createInvocationPlan<T extends InternalInvocationTypeMap>(
  _state: InvocationPlanningView<T>,
  plan: InvocationPlan<T>,
): InvocationAdapterResult<T, InvocationPlan<T>> {
  return { outcome: "succeeded", value: plan };
}

function bindInvocation<T extends InternalInvocationTypeMap>(
  adapters: InvocationAdapters<T>,
): BoundRunInvocation<T> {
  return ({ request, invocationRuntimeChecks }) =>
    runInvocation(adapters, {
      request,
      invocationRuntimeChecks,
    });
}

test("Request -> Promise<Response> visibly composes a call and notification", async () => {
  const events: string[] = [];
  const services: Services = { audit: [] };
  const execute = createSingleTakibiCall<Request, SingleDecoded, ActionSpec, Response>({
    callRuntimeChecks: undefined,
    async callDecode(request) {
      events.push("decode");
      return (await request.json()) as SingleDecoded;
    },
    callResolveContext() {
      events.push("resolveContext");
      return { tenantId: "tenant-1" };
    },
    callGetWireInvocation({ decoded }) {
      events.push("dispatch");
      return decoded.wireInvocation;
    },
    invocationRun: bindInvocation<ActionSpec>({
      invocationToInvocation: ({ input: _, ...invocation }) => invocation,
      invocationRuntime: {
        collections: { names: ["patients"] },
        storage: { scope: "base" },
        registry: { name: "actions" },
        logger: undefined,
        services,
      },
      invocationGetRawInput: (wireInvocation) => wireInvocation.input,
      invocationCreatePlan(state) {
        events.push("createPlan");
        return createInvocationPlan(state, {
          transactionBoundary: "none",
          work: {
            operation: { key: "action:register" },
          },
        });
      },
      transactionNone: {
        prepare() {
          return { outcome: "succeeded", value: {} };
        },
        apply(state) {
          events.push("execute");
          expect(state.plan.work.operation.key).toBe("action:register");
          if (state.input.status !== "raw") throw new Error("Expected raw input");
          const input = state.input.value;
          if (
            typeof input !== "object" ||
            input === null ||
            !("displayName" in input) ||
            typeof input.displayName !== "string"
          ) {
            throw new Error("VALIDATION");
          }
          return {
            outcome: "succeeded",
            value: { id: "patient-1" },
            updates: {
              input: { status: "validated", value: { displayName: input.displayName } },
            },
          };
        },
      },
      transactionApply: {
        prepare(): never {
          throw new Error("Unexpected apply boundary");
        },
        apply(): never {
          throw new Error("Unexpected apply boundary");
        },
      },
      transactionFull: {
        prepare(): never {
          throw new Error("Unexpected full boundary");
        },
        apply(): never {
          throw new Error("Unexpected full boundary");
        },
      },
      transactionRun: undefined,
      transactionClassifyFailure: undefined,
      invocationToFailure: toFailure,
      invocationSnapshotObserverEvent: snapshotObserverEvent,
      invocationNotify(observerEvent) {
        events.push("notify");
        if (observerEvent.invocation === undefined) {
          throw new Error("Expected initialized invocation");
        }
        services.audit.push(`${observerEvent.context.tenantId}:${observerEvent.invocation.name}`);
      },
    }),
    callToSingleResponse({ invocation }) {
      events.push("response");
      return Response.json(toWireResult(invocation));
    },
  });
  expectTypeOf(execute).toEqualTypeOf<(request: Request) => Promise<Response>>();
  const request = new Request("https://clinic.test/api", {
    method: "POST",
    body: JSON.stringify({
      kind: "single",
      wireInvocation: {
        kind: "action",
        scope: "patients",
        name: "register",
        input: { displayName: "Ada" },
      },
    } satisfies SingleDecoded),
  });

  const response = await execute(request);
  const body = (await response.json()) as WireResult<{ id: string }>;

  expect(body).toEqual({ ok: true, data: { id: "patient-1" } });
  expect(events).toEqual([
    "decode",
    "resolveContext",
    "dispatch",
    "createPlan",
    "execute",
    "notify",
    "response",
  ]);
  expect(services.audit).toEqual(["tenant-1:register"]);
});

test("one HTTP batch resolves once and creates one invocation state per item", async () => {
  let resolveCalls = 0;
  let runtimeCheckCalls = 0;
  const notifiedIds: string[] = [];
  const services: Services = { audit: [] };
  const execute = createBatchTakibiCall<Request, BatchDecoded, ReadSpec, Response>({
    callRuntimeChecks() {
      runtimeCheckCalls += 1;
      return true;
    },
    async callDecode(request) {
      return (await request.json()) as BatchDecoded;
    },
    callResolveContext() {
      resolveCalls += 1;
      return { tenantId: "tenant-1" };
    },
    callGetWireInvocations({ decoded }) {
      return decoded.items;
    },
    invocationRun: bindInvocation<ReadSpec>({
      invocationToInvocation(wire) {
        if (wire.id === "invalid-wire") throw new Error("INVALID_WIRE");
        return wire;
      },
      invocationRuntime: {
        collections: { names: ["patients"] },
        storage: { scope: "base" },
        registry: { name: "actions" },
        logger: undefined,
        services,
      },
      invocationGetRawInput: () => undefined as never,
      invocationCreatePlan(state) {
        return createInvocationPlan(state, {
          transactionBoundary: "none",
          work: {
            operation: { key: "collection:get" },
            id: state.invocation.id,
          },
        });
      },
      transactionNone: {
        prepare(_state, _work, storage) {
          expect(storage.scope).toBe("base");
          return { outcome: "succeeded", value: {} };
        },
        apply(state) {
          if (state.invocation.id === "missing") {
            return { outcome: "failed", error: new Error("NOT_FOUND") };
          }
          return { outcome: "succeeded", value: { id: state.invocation.id } };
        },
      },
      transactionApply: {
        prepare(): never {
          throw new Error("Unexpected apply boundary");
        },
        apply(): never {
          throw new Error("Unexpected apply boundary");
        },
      },
      transactionFull: {
        prepare(): never {
          throw new Error("Unexpected full boundary");
        },
        apply(): never {
          throw new Error("Unexpected full boundary");
        },
      },
      transactionRun: undefined,
      transactionClassifyFailure: undefined,
      invocationToFailure: toFailure,
      invocationSnapshotObserverEvent: snapshotObserverEvent,
      invocationNotify(observerEvent) {
        if (observerEvent.invocation === undefined) {
          notifiedIds.push("<uninitialized>");
          return;
        }
        notifiedIds.push(observerEvent.invocation.id);
      },
    }),
    callToBatchResponse({ invocations }) {
      return Response.json({ ok: true, data: invocations.map(toWireResult) });
    },
  });
  const request = new Request("https://clinic.test/api/_batch", {
    method: "POST",
    body: JSON.stringify({
      kind: "batch",
      items: [
        { kind: "collection", collection: "patients", operation: "get", id: "patient-1" },
        { kind: "collection", collection: "patients", operation: "get", id: "invalid-wire" },
        { kind: "collection", collection: "patients", operation: "get", id: "missing" },
        { kind: "collection", collection: "patients", operation: "get", id: "patient-2" },
      ],
    } satisfies BatchDecoded),
  });

  const response = await execute(request);
  const body = await response.json();

  expect(resolveCalls).toBe(1);
  expect(runtimeCheckCalls).toBe(1);
  expect(notifiedIds).toEqual(["patient-1", "<uninitialized>", "missing", "patient-2"]);
  expect(body).toEqual({
    ok: true,
    data: [
      { ok: true, data: { id: "patient-1" } },
      {
        ok: false,
        error: {
          kind: "operation",
          code: "INVALID_WIRE",
          message: "INVALID_WIRE",
          status: 500,
        },
      },
      {
        ok: false,
        error: {
          kind: "operation",
          code: "NOT_FOUND",
          message: "NOT_FOUND",
          status: 500,
        },
      },
      { ok: true, data: { id: "patient-2" } },
    ],
  });
});

test("Durable Object adapters take context from the decoded wire envelope", async () => {
  type WireDecoded = {
    readonly kind: "single";
    readonly context: AppContext;
    readonly wireInvocation: ActionWire;
  };
  let resolveCalls = 0;
  const execute = createSingleTakibiCall<Request, WireDecoded, ActionSpec, Response>({
    callRuntimeChecks: undefined,
    async callDecode(request) {
      return (await request.json()) as WireDecoded;
    },
    callResolveContext({ decoded }) {
      resolveCalls += 1;
      return decoded.context;
    },
    callGetWireInvocation({ decoded }) {
      return decoded.wireInvocation;
    },
    invocationRun: bindInvocation<ActionSpec>({
      invocationToInvocation: ({ input: _, ...invocation }) => invocation,
      invocationRuntime: {
        collections: { names: ["patients"] },
        storage: { scope: "base" },
        registry: { name: "actions" },
        logger: undefined,
        services: { audit: [] },
      },
      invocationGetRawInput: (wireInvocation) => wireInvocation.input,
      invocationCreatePlan(state) {
        return createInvocationPlan(state, {
          transactionBoundary: "none",
          work: {
            operation: { key: "action:register" },
          },
        });
      },
      transactionNone: {
        prepare() {
          return { outcome: "succeeded", value: {} };
        },
        apply() {
          return { outcome: "succeeded", value: { id: "patient-1" } };
        },
      },
      transactionApply: {
        prepare(): never {
          throw new Error("Unexpected apply boundary");
        },
        apply(): never {
          throw new Error("Unexpected apply boundary");
        },
      },
      transactionFull: {
        prepare(): never {
          throw new Error("Unexpected full boundary");
        },
        apply(): never {
          throw new Error("Unexpected full boundary");
        },
      },
      transactionRun: undefined,
      transactionClassifyFailure: undefined,
      invocationToFailure: toFailure,
      invocationSnapshotObserverEvent: snapshotObserverEvent,
      invocationNotify: undefined,
    }),
    callToSingleResponse({ invocation }) {
      return Response.json(toWireResult(invocation));
    },
  });

  const response = await execute(
    new Request("https://takibi.internal/", {
      method: "POST",
      body: JSON.stringify({
        kind: "single",
        context: { tenantId: "tenant-from-wire" },
        wireInvocation: {
          kind: "action",
          scope: "patients",
          name: "register",
          input: { displayName: "Ada" },
        },
      } satisfies WireDecoded),
    }),
  );

  expect(resolveCalls).toBe(1);
  expect(await response.json()).toEqual({ ok: true, data: { id: "patient-1" } });
});
