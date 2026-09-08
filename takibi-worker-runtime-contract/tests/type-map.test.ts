import { expect, expectTypeOf, test } from "vite-plus/test";
import type {
  InvocationRequestData,
  JsonValue,
  ObserverInvocationData,
  TakibiFailure,
} from "@takibi/takibi-shared-types";
import {
  toObservedInput,
  type InternalInvocationRuntime,
  type InternalInvocationTypeMap,
  type InvocationObserverEvent,
  type InvocationResult,
  type InvocationRuntime,
  type InvocationTransactionBoundaryContracts,
  type ObservedInput,
} from "../src";

type ValidMap = {
  wireInvocation: InvocationRequestData;
  invocation: ObserverInvocationData;
  runtime: InvocationRuntime;
  context: object;
  rawInput: unknown;
  input: unknown;
  noneWork: unknown;
  applyWork: unknown;
  fullWork: unknown;
  nonePrepared: unknown;
  applyPrepared: unknown;
  fullPrepared: unknown;
  result: JsonValue;
  failure: TakibiFailure<string>;
};

type WithSlot<K extends keyof ValidMap, V> = Omit<ValidMap, K> & { [P in K]: V };

test("valid maps extend the shared invocation contract", () => {
  expectTypeOf<ValidMap>().toExtend<InternalInvocationTypeMap>();
});

test("result Date is rejected at the map constraint", () => {
  expectTypeOf<WithSlot<"result", Date>>().not.toExtend<InternalInvocationTypeMap>();
});

test("failure string is rejected at the map constraint", () => {
  expectTypeOf<WithSlot<"failure", string>>().not.toExtend<InternalInvocationTypeMap>();
});

test("context string is rejected at the map constraint", () => {
  expectTypeOf<WithSlot<"context", string>>().not.toExtend<InternalInvocationTypeMap>();
});

test("batch wireInvocation is rejected at the map constraint", () => {
  expectTypeOf<
    WithSlot<"wireInvocation", { kind: "batch"; items: readonly [] }>
  >().not.toExtend<InternalInvocationTypeMap>();
});

test("runtime is independent of the invocation type map", () => {
  const runtime: InvocationRuntime = {
    collections: { names: ["patients"] },
    storage: { scope: "base" },
    registry: { name: "actions" },
    logger: undefined,
    services: { queue: { name: "audit" } },
  };

  expectTypeOf(runtime).toExtend<InvocationRuntime>();
  expectTypeOf<InvocationRuntime>().not.toHaveProperty("result");
  expectTypeOf<InvocationRuntime>().not.toHaveProperty("failure");
  expectTypeOf<InvocationRuntime>().not.toHaveProperty("input");
  expectTypeOf<InternalInvocationRuntime<ValidMap>>().toEqualTypeOf<ValidMap["runtime"]>();
});

test("narrow result, context, and runtime services reach result types", () => {
  type NarrowMap = Omit<ValidMap, "result" | "context" | "runtime"> & {
    result: { id: string };
    context: { tenantId: string };
    runtime: InvocationRuntime & { services: { queue: { name: string } } };
  };

  expectTypeOf<NarrowMap>().toExtend<InternalInvocationTypeMap>();

  type SucceededEvent = Extract<InvocationObserverEvent<NarrowMap>, { outcome: "succeeded" }>;
  expectTypeOf<SucceededEvent["result"]>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<SucceededEvent["context"]>().toEqualTypeOf<{ tenantId: string }>();
  expectTypeOf<SucceededEvent>().not.toHaveProperty("services");
  expectTypeOf<SucceededEvent["invocation"]>().toEqualTypeOf<NarrowMap["invocation"]>();

  type FailedEvent = Extract<InvocationObserverEvent<NarrowMap>, { outcome: "failed" }>;
  expectTypeOf<FailedEvent["invocation"]>().toEqualTypeOf<NarrowMap["invocation"] | undefined>();
  expectTypeOf<FailedEvent>().toHaveProperty("stage");
  expectTypeOf<FailedEvent>().toHaveProperty("failure");

  type SucceededResult = Extract<
    InvocationResult<NarrowMap>,
    { settlement: { outcome: "succeeded" } }
  >;
  expectTypeOf<SucceededResult["settlement"]["result"]>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<SucceededResult["context"]>().toEqualTypeOf<{ tenantId: string }>();
  expectTypeOf<SucceededResult["runtime"]["services"]>().toEqualTypeOf<{
    queue: { name: string };
  }>();
});

test("observed input can be narrowed and keeps validated undefined", () => {
  type Observed = ObservedInput<{ name: string } | undefined>;

  const unavailable: Observed = { status: "unavailable" };
  const validatedUndefined: Observed = { status: "validated", value: undefined };
  const validatedValue: Observed = { status: "validated", value: { name: "Ada" } };

  expectTypeOf(unavailable).not.toHaveProperty("value");
  if (validatedUndefined.status === "validated") {
    expectTypeOf(validatedUndefined.value).toEqualTypeOf<{ name: string } | undefined>();
  }
  if (validatedValue.status === "validated") {
    expectTypeOf(validatedValue.value).toEqualTypeOf<{ name: string } | undefined>();
  }

  expect(toObservedInput({ status: "validated", value: undefined })).toEqual({
    status: "validated",
    value: undefined,
  });
  expect(toObservedInput({ status: "raw", value: { secret: true } })).toEqual({
    status: "unavailable",
  });
  expect(toObservedInput({ status: "rejected" })).toEqual({ status: "unavailable" });
  expect(toObservedInput({ status: "not-applicable" })).toEqual({ status: "unavailable" });
});

test("work and prepared stay paired on the apply contract", () => {
  type CustomMap = Omit<ValidMap, "noneWork" | "nonePrepared"> & {
    noneWork: { token: "work" };
    nonePrepared: { token: "prepared" };
  };
  type Contracts = InvocationTransactionBoundaryContracts<CustomMap>;

  expectTypeOf<Contracts["none"]["prepare"]>().parameter(1).toEqualTypeOf<{ token: "work" }>();
  expectTypeOf<Contracts["none"]["apply"]>().parameter(1).toEqualTypeOf<{ token: "prepared" }>();

  const rejectedPrepared = (
    apply: Contracts["none"]["apply"],
    state: Parameters<Contracts["none"]["apply"]>[0],
    storage: CustomMap["runtime"]["storage"],
  ) => {
    void apply(state, { token: "prepared" }, storage);
    // @ts-expect-error apply must receive the prepared type returned by prepare
    void apply(state, { token: "other" }, storage);
  };

  expectTypeOf(rejectedPrepared).toBeFunction();
});
