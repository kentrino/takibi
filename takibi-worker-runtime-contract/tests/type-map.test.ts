import { expectTypeOf, test } from "vite-plus/test";
import type {
  InvocationRequestData,
  JsonValue,
  ObserverInvocationData,
  TakibiFailure,
} from "@takibi/takibi-shared-types";
import type {
  InternalInvocationTypeMap,
  InvocationObserverEvent,
  InvocationResult,
  InvocationTransactionBoundaryContracts,
} from "../src";

type ValidMap = {
  wireInvocation: InvocationRequestData;
  invocation: ObserverInvocationData;
  collections: unknown;
  storage: unknown;
  registry: unknown;
  context: object;
  logger: unknown;
  services: unknown;
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

test("narrow result, context, and services reach observer and result types", () => {
  type NarrowMap = Omit<ValidMap, "result" | "context" | "services"> & {
    result: { id: string };
    context: { tenantId: string };
    services: { queue: { name: string } };
  };

  expectTypeOf<NarrowMap>().toExtend<InternalInvocationTypeMap>();

  type SucceededEvent = Extract<InvocationObserverEvent<NarrowMap>, { outcome: "succeeded" }>;
  expectTypeOf<SucceededEvent["result"]>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<SucceededEvent["context"]>().toEqualTypeOf<{ tenantId: string }>();
  expectTypeOf<SucceededEvent["services"]>().toEqualTypeOf<{ queue: { name: string } }>();

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
    storage: CustomMap["storage"],
  ) => {
    void apply(state, { token: "prepared" }, storage);
    // @ts-expect-error apply must receive the prepared type returned by prepare
    void apply(state, { token: "other" }, storage);
  };

  expectTypeOf(rejectedPrepared).toBeFunction();
});
