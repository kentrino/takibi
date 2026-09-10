import { expectTypeOf, test } from "vite-plus/test";
import * as Takibi from "@takibi/takibi";
import * as Client from "@takibi/takibi/client";
import * as Instrumentation from "@takibi/takibi/instrumentation";
import * as Testing from "@takibi/takibi/testing";

test("public entries expose the documented consumer contracts", () => {
  expectTypeOf(Takibi.createTakibi).toBeFunction();
  expectTypeOf(Takibi.grant).toBeFunction();
  expectTypeOf(Takibi.TakibiError).toBeConstructibleWith("CODE", "message");

  expectTypeOf(Client.createClient).toBeFunction();
  expectTypeOf(Instrumentation.registerGlobalTracer).toBeFunction();
  expectTypeOf(Testing.withSqliteTestBackend).toBeFunction();
});

test("specialized entry contracts stay off the root entry", () => {
  expectTypeOf(Takibi).not.toHaveProperty("createClient");
  expectTypeOf(Takibi).not.toHaveProperty("withSqliteTestBackend");
  expectTypeOf(Takibi).not.toHaveProperty("registerGlobalTracer");
});
