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

test("execution result types are independent of response serialization", () => {
  expectTypeOf<WithSlot<"result", Date>>().toExtend<InternalInvocationTypeMap>();
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

test("one runtime type map preserves request, context, response and facade relationships", () => {
  type Invocation = WithSlot<"context", { tenant: string }>;
  type Types = {
    invocation: Invocation;
    request: { url: string };
    decoded: { operation: string };
    response: { status: number };
    localExecution: { execute(): Promise<string> };
  };
  type Map = import("../src").RuntimeAdapterMap<Types>;
  type Decode = import("../src").Adapters<Types, "callDecode">;
  expectTypeOf<Parameters<Decode["callDecode"]>[0]>().toEqualTypeOf<Types["request"]>();
  expectTypeOf<Awaited<ReturnType<Decode["callDecode"]>>>().toEqualTypeOf<Types["decoded"]>();
  expectTypeOf<Awaited<ReturnType<Map["callResolveContext"]>>>().toEqualTypeOf<
    Invocation["context"]
  >();
  expectTypeOf<Parameters<Map["callToSingleResponse"]>[0]["invocation"]>().toEqualTypeOf<
    InvocationResult<Invocation>
  >();
  expectTypeOf<Awaited<ReturnType<Map["callSingle"]>>>().toEqualTypeOf<Types["response"]>();
  expectTypeOf<Map["localExecution"]>().toEqualTypeOf<Types["localExecution"]>();
  expectTypeOf<Decode>().not.toHaveProperty("invocationRuntime");
});

test("adapter collaborators and logger are typed on the contract map", () => {
  type Map = import("../src").RuntimeAdapterMap;
  type Policy = import("../src").PolicySurface;
  type Schema = import("../src").SchemaSurface;
  type HandlerCtor = import("../src").ActionHandlerCtor;
  type Handler = import("../src").ActionHandlerSurface;
  type Logger = import("../src").InternalLogger;
  type PrepareDeps = import("../src").InvocationPrepareApplyDeps;

  expectTypeOf<import("../src").InvocationRuntime["logger"]>().toEqualTypeOf<Logger | undefined>();
  expectTypeOf<Logger>().toEqualTypeOf<import("@takibi/takibi-logger").InternalLogger>();
  expectTypeOf<import("../src").LogEvent>().toEqualTypeOf<
    import("@takibi/takibi-logger").LogEvent
  >();
  expectTypeOf<Map["invocationPolicy"]>().toEqualTypeOf<Policy>();
  expectTypeOf<Map["invocationSchema"]>().toEqualTypeOf<Schema>();
  expectTypeOf<Map["invocationActionHandler"]>().toEqualTypeOf<(ctor: HandlerCtor) => Handler>();
  expectTypeOf<PrepareDeps>().toEqualTypeOf<
    Pick<Map, "invocationPolicy" | "invocationSchema" | "invocationActionHandler">
  >();

  const rejectedPolicy = (policy: Policy) => {
    void policy;
    const incomplete = {
      evaluateCollection: policy.evaluateCollection,
    };
    // @ts-expect-error policy adapters must implement evaluateAction
    const assigned: Policy = incomplete;
    void assigned;
  };
  expectTypeOf(rejectedPolicy).toBeFunction();

  const optionalLogger = (runtime: import("../src").InvocationRuntime) => {
    runtime.logger?.emit({
      level: "debug",
      event: "takibi.schema",
      message: "completed",
    });
  };
  expectTypeOf(optionalLogger).toBeFunction();
});

test("schema parse keeps Standard Schema output inference", () => {
  type LengthSchema = import("@standard-schema/spec").StandardSchemaV1<string, number>;
  const parse = async <S extends import("@standard-schema/spec").StandardSchemaV1>(
    schema: S,
    value: unknown,
  ): Promise<import("@standard-schema/spec").StandardSchemaV1.InferOutput<S>> => {
    void schema;
    void value;
    return undefined as never;
  };
  const schemaSurface: import("../src").SchemaSurface = { parse };
  const lengthSchema = {} as LengthSchema;
  expectTypeOf(schemaSurface.parse(lengthSchema, "hello")).toEqualTypeOf<Promise<number>>();
});

test("envelope call is derived from the envelope type arguments", () => {
  type RequestLike = { readonly url: string };
  type Decoded = { readonly name: string };
  type Context = { readonly tenantId: string };
  type ResponseObject = { readonly status: number };
  type Dispatched = { readonly ok: true };
  type Envelope = import("../src").EnvelopeAdapterMap<
    RequestLike,
    Decoded,
    Context,
    ResponseObject,
    Dispatched
  >;
  type ExpectedCall = import("../src").Call<
    RequestLike,
    Decoded,
    Context,
    ResponseObject,
    Dispatched
  >;

  expectTypeOf<Envelope["call"]>().toEqualTypeOf<ExpectedCall>();
  expectTypeOf<Envelope["call"]["run"]>().toEqualTypeOf<
    (request: RequestLike) => Promise<ResponseObject>
  >();
  expectTypeOf<Envelope["call"]["decode"]>().toEqualTypeOf<
    (request: RequestLike) => Promise<Decoded>
  >();
  expectTypeOf<Envelope>().not.toHaveProperty("invocationRuntime");
});

test("action handler arguments require the common execution context", () => {
  type Args = Parameters<import("../src").ActionHandlerSurface["run"]>[0];
  type CommonArgs = {
    ctx: { tenantId: string };
    collections: {};
    $collections: {};
    services: { audit: string[] };
    input: undefined;
  };
  expectTypeOf<CommonArgs>().toExtend<Args>();
  expectTypeOf<Omit<CommonArgs, "ctx">>().not.toExtend<Args>();
  expectTypeOf<Omit<CommonArgs, "collections">>().not.toExtend<Args>();
  expectTypeOf<Omit<CommonArgs, "$collections">>().not.toExtend<Args>();
  expectTypeOf<Omit<CommonArgs, "services">>().not.toExtend<Args>();
  expectTypeOf<Omit<CommonArgs, "input">>().not.toExtend<Args>();
});
