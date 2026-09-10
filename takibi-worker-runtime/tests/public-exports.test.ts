import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Runtime from "@takibi/takibi-worker-runtime";
import * as Instrumentation from "@takibi/takibi-worker-runtime/instrumentation";
import * as TestingBridge from "@takibi/takibi-worker-runtime/testing-bridge";

test("root entry exposes the Worker runtime contract", () => {
  expectTypeOf(Runtime.createTakibi).toBeFunction();
  expectTypeOf(Runtime.createDurableObjectClass).toBeFunction();
  expectTypeOf<Runtime.HandleResult>().not.toBeNever();
});

test("dedicated subpaths expose instrumentation and test integration", () => {
  expect(Instrumentation.TAKIBI_SPAN.wire).toBe("takibi.wire");
  expectTypeOf(Instrumentation.registerGlobalTracer).toBeFunction();
  expectTypeOf(TestingBridge.registerTestingFork).toBeFunction();
  expectTypeOf(TestingBridge.createInProcessRuntime).toBeFunction();
  expectTypeOf(Runtime).not.toHaveProperty("createInProcessRuntime");
});
