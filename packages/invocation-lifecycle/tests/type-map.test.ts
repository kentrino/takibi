import { expect, expectTypeOf, test } from "vite-plus/test";
import type {
  InternalInvocationTypeMap,
  InvocationExecutionView,
  InvocationObserverEvent,
  InvocationResult,
  InvocationTransactionBoundaryContracts,
  ObservedInput,
} from "@takibi/invocation-lifecycle";
import { toObservedInput } from "../src/type";

type ValidMap = {
  wireInvocation: { readonly kind: "anything"; readonly input?: unknown };
  invocation: { readonly kind: "anything" };
  runtime: {
    storage: { readonly scope: "base" | "transaction" };
    services: { readonly audit: readonly string[] };
  };
  context: { readonly tenantId: string };
  currentContext: { readonly tenantId: string; readonly subject?: string };
  rawInput: unknown;
  input: { readonly name: string } | undefined;
  noneWork: { readonly token: "none-work" };
  applyWork: { readonly token: "apply-work" };
  fullWork: { readonly token: "full-work" };
  nonePrepared: { readonly token: "none-prepared" };
  applyPrepared: { readonly token: "apply-prepared" };
  fullPrepared: { readonly token: "full-prepared" };
  result: Date;
  failure: string;
};

test("the base map keeps invocation values opaque", () => {
  expectTypeOf<ValidMap>().toExtend<InternalInvocationTypeMap>();
  expectTypeOf<ValidMap["result"]>().toEqualTypeOf<Date>();
  expectTypeOf<ValidMap["failure"]>().toEqualTypeOf<string>();
});

test("execution views expose runtime capabilities except transaction storage", () => {
  type View = InvocationExecutionView<ValidMap>;
  expectTypeOf<View["runtime"]["services"]>().toEqualTypeOf<ValidMap["runtime"]["services"]>();
  expectTypeOf<View["runtime"]>().not.toHaveProperty("storage");
  expectTypeOf<View["baseContext"]>().toEqualTypeOf<ValidMap["context"]>();
  expectTypeOf<View["context"]>().toEqualTypeOf<ValidMap["context"] | ValidMap["currentContext"]>();
});

test("result and observer types preserve concrete slots", () => {
  type SucceededEvent = Extract<InvocationObserverEvent<ValidMap>, { outcome: "succeeded" }>;
  type SucceededResult = Extract<
    InvocationResult<ValidMap>,
    { settlement: { outcome: "succeeded" } }
  >;
  expectTypeOf<SucceededEvent["result"]>().toEqualTypeOf<Date>();
  expectTypeOf<SucceededEvent["invocation"]>().toEqualTypeOf<ValidMap["invocation"]>();
  expectTypeOf<SucceededResult["runtime"]>().toEqualTypeOf<ValidMap["runtime"]>();
  expectTypeOf<SucceededResult["settlement"]["result"]>().toEqualTypeOf<Date>();
});

test("work and prepared values stay paired by transaction boundary", () => {
  type Contracts = InvocationTransactionBoundaryContracts<ValidMap>;
  expectTypeOf<Contracts["none"]["prepare"]>().parameter(1).toEqualTypeOf<ValidMap["noneWork"]>();
  expectTypeOf<Contracts["none"]["apply"]>().parameter(1).toEqualTypeOf<ValidMap["nonePrepared"]>();
  expectTypeOf<Contracts["apply"]["prepare"]>().parameter(1).toEqualTypeOf<ValidMap["applyWork"]>();
  expectTypeOf<Contracts["full"]["apply"]>().parameter(1).toEqualTypeOf<ValidMap["fullPrepared"]>();
});

test("observed input hides raw and rejected values", () => {
  type Observed = ObservedInput<{ name: string } | undefined>;
  const validatedUndefined: Observed = { status: "validated", value: undefined };
  expectTypeOf(validatedUndefined).toExtend<Observed>();
  expect(toObservedInput({ status: "validated", value: undefined })).toEqual({
    status: "validated",
    value: undefined,
  });
  expect(toObservedInput({ status: "raw", value: { secret: true } })).toEqual({
    status: "unavailable",
  });
  expect(toObservedInput({ status: "rejected" })).toEqual({ status: "unavailable" });
});
