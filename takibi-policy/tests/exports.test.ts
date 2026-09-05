import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Policy from "../src";

test("policy package exports grants, composition, helpers, and evaluators", () => {
  expectTypeOf(Policy.grant).toBeFunction();
  expectTypeOf(Policy.and).toBeFunction();
  expectTypeOf(Policy.or).toBeFunction();
  expectTypeOf(Policy.allows).toBeFunction();
  expectTypeOf(Policy.permissionsOf).toBeFunction();
  expectTypeOf(Policy.evaluateAccessPolicy).toBeFunction();
  expectTypeOf(Policy.denialReasonOf).toBeFunction();
  expectTypeOf(Policy.createPolicyHelper).toBeFunction();
  expectTypeOf(Policy.isAccessGrant).toBeFunction();
  expectTypeOf(Policy.isContextPolicy).toBeFunction();
  expectTypeOf(Policy.isConstrainedPolicy).toBeFunction();
  expectTypeOf(Policy.none).toEqualTypeOf<Policy.AccessGrant>();
  expectTypeOf(Policy.read).toEqualTypeOf<Policy.AccessGrant>();
  expectTypeOf(Policy.write).toEqualTypeOf<Policy.AccessGrant>();
  expectTypeOf(Policy.fullAccess).toEqualTypeOf<Policy.AccessGrant>();
  expectTypeOf<Policy.AccessContext<{ tenantId: string }>>().toHaveProperty("permission");
  expectTypeOf<Policy.CollectionOperation>().toEqualTypeOf<
    "add" | "set" | "get" | "update" | "delete" | "list" | "count"
  >();
  expectTypeOf(Policy).not.toHaveProperty("GrantCatalog");
  expectTypeOf(Policy).not.toHaveProperty("queryImpliesEquality");
  expectTypeOf(Policy).not.toHaveProperty("defineCollection");
  expect(Policy.allows(Policy.grant("get"), "get")).toBe(true);
});
