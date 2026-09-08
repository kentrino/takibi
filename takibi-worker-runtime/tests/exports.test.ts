import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Runtime from "../src";
import * as Instrumentation from "../src/instrumentation";
import * as TestingBridge from "../src/testing-bridge.server";

test("worker-runtime exports createTakibi, handler types, and pretty logging", () => {
  expectTypeOf(Runtime.createTakibi).toBeFunction();
  expectTypeOf(Runtime.createPrettyConsoleLogger).toBeFunction();
  expectTypeOf(Runtime.otel).toBeFunction();
  expectTypeOf(Runtime.createBoundInvocationAdapters).toBeFunction();
  expectTypeOf(Runtime.resolveLocalAdapterMap).toBeFunction();
  expectTypeOf(Runtime.resolveLocalExecution).toBeFunction();
  expectTypeOf<Runtime.TakibiRuntimeAdapterMap>().not.toBeNever();
  expectTypeOf<Runtime.LocalExecution>().not.toBeNever();
  expectTypeOf(Runtime.toTakibiInvocation).toBeFunction();
  expectTypeOf(Runtime.getTakibiRawInput).toBeFunction();
  expectTypeOf<Runtime.TakibiHandler>().not.toBeNever();
  expectTypeOf<Runtime.CollectionsOptions>().not.toBeNever();
  expectTypeOf<Runtime.HandleOptions<Record<string, never>>>().not.toBeNever();
  expectTypeOf<Runtime.HandleResult>().not.toBeNever();
  expectTypeOf<Runtime.TakibiInvocationTypeMap>().not.toBeNever();
  expectTypeOf<Runtime.TakibiWireInvocation>().not.toBeNever();
  expectTypeOf(Runtime).not.toHaveProperty("resolveTakibiAdapterMap");
  expectTypeOf(Runtime).not.toHaveProperty("resolveTakibiCallAdapterMap");
  expectTypeOf(Runtime).not.toHaveProperty("createClient");
  expectTypeOf(Runtime).not.toHaveProperty("withSqliteTestBackend");
  expectTypeOf(Runtime).not.toHaveProperty("createSqliteDurableObjectStorage");
  expectTypeOf(Runtime).not.toHaveProperty("registerTestingFork");
  expectTypeOf(Runtime).not.toHaveProperty("getTestingFork");
  expectTypeOf(Runtime).not.toHaveProperty("createInProcessRuntime");
});

test("instrumentation subpath owns the telemetry vocabulary", () => {
  expect(Instrumentation.TAKIBI_SPAN.wire).toBe("takibi.wire");
  expect(Instrumentation.TAKIBI_ATTR.collection.name).toBe("takibi.collection.name");
  expectTypeOf(Instrumentation.registerGlobalTracer).toBeFunction();
});

test("testing-bridge is a dedicated subpath, not a root export", () => {
  expectTypeOf(TestingBridge.registerTestingFork).toBeFunction();
  expectTypeOf(TestingBridge.getTestingFork).toBeFunction();
  expectTypeOf(TestingBridge.createInProcessRuntime).toBeFunction();
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports["./testing-bridge"]).toBe("./src/testing-bridge.server.ts");
  expect(pkg.exports["."]).toBe("./src/index.ts");
});

test("published declarations keep testing-bridge off the root entry", () => {
  const dtsPath = join(import.meta.dirname, "../dist/index.d.mts");
  const jsPath = join(import.meta.dirname, "../dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).not.toMatch(/createInProcessRuntime|registerTestingFork|getTestingFork/);
  expect(js).not.toMatch(/createInProcessRuntime/);
});
