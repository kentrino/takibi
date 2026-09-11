import { expect, test } from "vite-plus/test";
import * as Runtime from "@takibi/worker-runtime";
import * as RuntimeInstrumentation from "@takibi/worker-runtime/instrumentation";
import * as ContextFacade from "../src/context";
import * as HttpFacade from "../src/http";
import * as InstrumentationFacade from "../src/instrumentation";
import * as LoggingFacade from "../src/logging";
import * as SnapshotFacade from "../src/snapshot";

test("Takibi runtime modules re-export the owner package bindings", () => {
  expect(ContextFacade.createTakibi).toBe(Runtime.createTakibi);
  expect(LoggingFacade.createPrettyConsoleLogger).toBe(Runtime.createPrettyConsoleLogger);
  expect(HttpFacade.decodePublicHttp).toBe(Runtime.decodePublicHttp);
  expect(SnapshotFacade.createDurableObjectCollectionsApi).toBe(
    Runtime.createDurableObjectCollectionsApi,
  );
  expect(SnapshotFacade.createTakibiSnapshotLifecycle).toBe(Runtime.createTakibiSnapshotLifecycle);
  expect(InstrumentationFacade.TAKIBI_SPAN).toBe(RuntimeInstrumentation.TAKIBI_SPAN);
  expect(InstrumentationFacade.TAKIBI_ATTR).toBe(RuntimeInstrumentation.TAKIBI_ATTR);
  expect(InstrumentationFacade.registerGlobalTracer).toBe(
    RuntimeInstrumentation.registerGlobalTracer,
  );
});
