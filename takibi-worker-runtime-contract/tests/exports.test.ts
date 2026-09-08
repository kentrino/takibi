import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Contract from "../src/index";
import type {
  AdapterMap,
  Adapters,
  CallAdapters,
  CallTypeMap,
  JsonResponseLike,
  LocalCallRequest,
  LocalCallTypeMap,
  StatusBearingResult,
  CreateBatchTakibiCall,
  CreateSingleTakibiCall,
  InternalInvocationTypeMap,
  InvocationAdapters,
  RuntimeAdapterMap,
  InvocationPlanningView,
  InvocationRequest,
  InvocationResult,
  InvocationRunOptions,
  RunCall,
  RunBatchCall,
  RunSingleCall,
} from "../src/index";
// @ts-expect-error Phase-specific implementation view is not part of the root contract.
import type { InternalInvocationState$ActionResolved } from "../src/index";
// @ts-expect-error Phase-specific implementation view is not part of the root contract.
import type { InternalInvocationState$CollectionResolvedWith } from "../src/index";
// @ts-expect-error Transition helper view is not part of the root contract.
import type { InternalInvocationInitializationView } from "../src/index";

test("root exports linear call composition and the invocation orchestrator", () => {
  expect(Contract.runCall).toBeTypeOf("function");
  expect(Contract.InvocationState).toBeTypeOf("function");
  expect(Contract.runInvocation).toBeTypeOf("function");
  expect(Contract.executePlan).toBeTypeOf("function");
  expect(Contract.createSingleTakibiCall).toBeTypeOf("function");
  expect(Contract.createBatchTakibiCall).toBeTypeOf("function");
  expect(Contract.decodeLocalCallRequest).toBeTypeOf("function");
  expect(Contract.localSingleCall).toBeTypeOf("function");
  expect(Contract.jsonResponseFromStatus).toBeTypeOf("function");
  expect(Contract.statusOfResult).toBeTypeOf("function");
  expect(Contract.runSingleCall).toBeTypeOf("function");
  expect(Contract.runBatchCall).toBeTypeOf("function");

  expect(Contract).not.toHaveProperty("createTakibiCall");
  expect(Contract).not.toHaveProperty("runInvocationSequence");
  expect(Contract).not.toHaveProperty("resolveActionInvocation");
  expect(Contract).not.toHaveProperty("createPublicInvocationContext");
  expect(Contract).not.toHaveProperty("executeExecutionPlan");
  expect(Contract).not.toHaveProperty("BoundInvocationAdapters");

  expectTypeOf<CreateSingleTakibiCall>().toBeFunction();
  expectTypeOf<CreateBatchTakibiCall>().toBeFunction();
  expectTypeOf<RunCall>().toBeFunction();
  expectTypeOf<RunSingleCall>().toBeFunction();
  expectTypeOf<RunBatchCall>().toBeFunction();
  expectTypeOf<CallAdapters<unknown, unknown, unknown, unknown>>().toHaveProperty("dispatch");
  expectTypeOf<CallAdapters<unknown, unknown, unknown, unknown>>().toHaveProperty("resolveContext");
  expectTypeOf<InvocationAdapters<InternalInvocationTypeMap>>().not.toHaveProperty(
    "wireInvocation",
  );
  expectTypeOf<InvocationAdapters<InternalInvocationTypeMap>>().not.toHaveProperty("context");
  expectTypeOf<InvocationAdapters<InternalInvocationTypeMap>>().toHaveProperty("invocationRuntime");
  expectTypeOf<InvocationRunOptions<InternalInvocationTypeMap>>().toHaveProperty("request");
  expectTypeOf<InvocationRunOptions<InternalInvocationTypeMap>>().not.toHaveProperty("adapters");
  expectTypeOf<
    "plan" extends keyof InvocationPlanningView<InternalInvocationTypeMap> ? true : false
  >().toEqualTypeOf<false>();
  expectTypeOf<InvocationRequest<InternalInvocationTypeMap>>().toHaveProperty("wireInvocation");
  expectTypeOf<InvocationResult<InternalInvocationTypeMap>>().toHaveProperty("settlement");
  expectTypeOf<InvocationResult<InternalInvocationTypeMap>>().toHaveProperty("plan");
  expectTypeOf<AdapterMap<InternalInvocationTypeMap>>().toHaveProperty("invocationRun");
  expectTypeOf<AdapterMap<InternalInvocationTypeMap>>().not.toHaveProperty("invocationCoreRun");
  type RuntimeMap = RuntimeAdapterMap<
    InternalInvocationTypeMap,
    CallTypeMap<unknown, unknown, InternalInvocationTypeMap, unknown>,
    unknown
  >;
  expectTypeOf<RuntimeMap>().toHaveProperty("invocationCoreRun");
  expectTypeOf<RuntimeMap>().toHaveProperty("callSingle");
  expectTypeOf<RuntimeMap>().not.toHaveProperty("wireCallSingle");
  expectTypeOf<RuntimeMap>().toExtend<AdapterMap<InternalInvocationTypeMap>>();
  expectTypeOf<StatusBearingResult>().toMatchTypeOf<
    { ok: true } | { ok: false; error: { status: number } }
  >();
  expectTypeOf<JsonResponseLike<string>>().toHaveProperty("json");
  expectTypeOf<LocalCallRequest<{ tenantId: string }, { id: string }>>().toHaveProperty("kind");
  expectTypeOf<LocalCallTypeMap<InternalInvocationTypeMap, unknown>["request"]>().toHaveProperty(
    "kind",
  );
  expect(Contract.INVOCATION_ADAPTER_KEYS).toContain("invocationCreatePlan");
  expect(Contract.CALL_SINGLE_ADAPTER_KEYS).toContain("callToSingleResponse");
  expect(Contract.RUNTIME_ADAPTER_GRAPH.callSingle).toEqual([...Contract.CALL_SINGLE_ADAPTER_KEYS]);
  expect(Contract.RUNTIME_ADAPTER_GRAPH).not.toHaveProperty("wireCallSingle");
  expectTypeOf<Adapters<InternalInvocationTypeMap, "invocationCreatePlan">>().not.toHaveProperty(
    "invocationRuntime",
  );

  expectTypeOf<InternalInvocationState$ActionResolved>().toBeAny();
  expectTypeOf<InternalInvocationState$CollectionResolvedWith>().toBeAny();
  expectTypeOf<InternalInvocationInitializationView>().toBeAny();
});
