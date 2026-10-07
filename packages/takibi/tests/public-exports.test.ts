import { expect, expectTypeOf, test } from "vite-plus/test";
import { isListWhereScope } from "@takibi/query";
import { listDecisionOf } from "@takibi/policy";
import * as Takibi from "takibi";
import * as Client from "takibi/client";
import * as Instrumentation from "takibi/instrumentation";
import * as Testing from "takibi/testing";

test("public entries expose the documented consumer contracts", () => {
  expectTypeOf(Takibi.createTakibi).toBeFunction();
  expectTypeOf(Takibi.grant).toBeFunction();
  const scope = Takibi.listWhere<{ owner: string }>((q) => q.owner.eq("u1"));
  expect(isListWhereScope(scope)).toBe(true);
  expect(listDecisionOf(Takibi.grant(scope))).toEqual({ kind: "allowWhere", where: scope.where });
  expectTypeOf(Takibi.TakibiError).toBeConstructibleWith("CODE", "message");

  expectTypeOf(Client.createClient).toBeFunction();
  expectTypeOf(Instrumentation.registerGlobalTracer).toBeFunction();
  expectTypeOf(Testing.withSqliteTestBackend).toBeFunction();
});

test("specialized entry contracts stay off the root entry", () => {
  expectTypeOf(Takibi).not.toHaveProperty("createClient");
  expectTypeOf(Takibi).not.toHaveProperty("withSqliteTestBackend");
  expectTypeOf(Takibi).not.toHaveProperty("registerGlobalTracer");
  expectTypeOf(Takibi).not.toHaveProperty("constrainedPolicyBrand");
  expectTypeOf(Takibi).not.toHaveProperty("contextPolicyBrand");
});
