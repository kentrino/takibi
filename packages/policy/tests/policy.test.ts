import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  allows,
  and,
  createPolicyHelper,
  denialReasonOf,
  evaluateAccessPolicy,
  fullAccess,
  grant,
  isAccessGrant,
  isConstrainedPolicy,
  isContextPolicy,
  none,
  or,
  permissionsOf,
  read,
  write,
} from "@takibi/policy";
import type { AccessContext, AccessGrant, AccessPermission } from "@takibi/policy";

type Ctx = { tenantId: string; user: { id: string } | null };

const ACCESS_PERMISSIONS = [
  "create",
  "get",
  "list",
  "update",
  "delete",
  "invoke",
] as const satisfies readonly AccessPermission[];

function ctx(permission: AccessContext<Ctx>["permission"]): AccessContext<Ctx> {
  return {
    tenantId: "t",
    user: { id: "u1" },
    collection: "items",
    operation: permission === "create" ? "add" : permission,
    permission,
  };
}

function actionsOf(value: AccessGrant): AccessPermission[] {
  return ACCESS_PERMISSIONS.filter((permission) => allows(value, permission));
}

function tryAddDelete(value: AccessGrant): void {
  const mutator = value as unknown as { add?: (permission: AccessPermission) => void };
  mutator.add?.("delete");
}

test("internal membership matches predefined grants", () => {
  expect(actionsOf(write)).toEqual(["create", "update", "delete"]);
  expect(allows(write, "delete")).toBe(true);
  expect(allows(write, "get")).toBe(false);
  expect(allows(write, "list")).toBe(false);
  expect(allows(write, "invoke")).toBe(false);
  expect(allows(read, "get")).toBe(true);
  expect(allows(read, "update")).toBe(false);
  expect(allows(none, "list")).toBe(false);
  expect(allows(grant("create"), "create")).toBe(true);
  expect(allows(grant("create"), "update")).toBe(false);
  for (const permission of ACCESS_PERMISSIONS) {
    expect(allows(fullAccess, permission)).toBe(true);
  }
});

test("and intersects grants and or unions them", async () => {
  const staff = () => fullAccess;
  const seededReadOnly = () => read;
  const guest = () => none;

  expect(actionsOf(await and(staff, seededReadOnly)(ctx("get")))).toEqual(actionsOf(read));
  expect(allows(await and(staff, seededReadOnly)(ctx("update")), "update")).toBe(false);
  expect(allows(await and(staff, guest)(ctx("get")), "get")).toBe(false);

  expect(actionsOf(await or(guest, read)(ctx("list")))).toEqual(actionsOf(read));
  expect(allows(await or(read, grant("create"))(ctx("create")), "create")).toBe(true);
  const readWrite = await or(read, write)(ctx("delete"));
  expect(actionsOf(readWrite)).toEqual(["create", "get", "list", "update", "delete"]);
  expect(allows(readWrite, "invoke")).toBe(false);
  expect(await or(read, write, grant("invoke"))(ctx("get"))).toBe(fullAccess);
});

test("and/or accept constant grants", async () => {
  const staff = () => fullAccess;
  expect(allows(await and(staff, read)(ctx("get")), "get")).toBe(true);
  expect(allows(await and(staff, read)(ctx("delete")), "delete")).toBe(false);
  expect(allows(await or(none, grant("create"))(ctx("create")), "create")).toBe(true);
});

test("and short-circuits on none", async () => {
  const calls: string[] = [];
  const first = () => {
    calls.push("first");
    return none;
  };
  const second = () => {
    calls.push("second");
    return write;
  };
  expect(await and(first, second)(ctx("get"))).toBe(none);
  expect(calls).toEqual(["first"]);
});

test("shared and combined grants stay closed after a Set mutator attempt", async () => {
  for (const value of [
    none,
    read,
    write,
    fullAccess,
    grant("get"),
    await or(none, read)(ctx("get")),
  ]) {
    tryAddDelete(value);
  }
  expect(allows(none, "delete")).toBe(false);
  expect(allows(read, "delete")).toBe(false);
  expect(allows(await or(none, read)(ctx("get")), "delete")).toBe(false);
});

test("catalog callback grants match string-literal grants", () => {
  const listed = grant("create", "get");
  const selected = grant((g) => [g.create, g.get]);
  const listedInvoke = grant("list", "invoke");
  const selectedInvoke = grant((g) => [g.list, g.invoke]);

  expectTypeOf(listed).toEqualTypeOf<AccessGrant>();
  expectTypeOf(selected).toEqualTypeOf<AccessGrant>();
  expect(actionsOf(selected)).toEqual(actionsOf(listed));
  expect(actionsOf(selectedInvoke)).toEqual(actionsOf(listedInvoke));
  expect(actionsOf(grant())).toEqual([]);
  expect(actionsOf(grant((_g) => []))).toEqual([]);

  // @ts-expect-error unknown permission literal
  grant("admin");
  // @ts-expect-error unknown catalog property
  grant((g) => [g.admin]);
});

test("isAccessGrant accepts only WeakMap-backed grants", () => {
  expect(isAccessGrant(none)).toBe(true);
  expect(isAccessGrant(grant("get"))).toBe(true);
  expect(isAccessGrant({})).toBe(false);
  expect(isAccessGrant({ has: () => true, size: 1 })).toBe(false);
  expect(isAccessGrant(new Set(["get"]))).toBe(false);
  expect(isAccessGrant(null)).toBe(false);
  expect(isAccessGrant(undefined)).toBe(false);
  expect(isAccessGrant("get")).toBe(false);
  expect(permissionsOf({} as AccessGrant).size).toBe(0);
});

test("async policies resolve and propagate errors", async () => {
  const delayed = async () => {
    await Promise.resolve();
    return grant("get");
  };
  expect(allows(await evaluateAccessPolicy(delayed, ctx("get")), "get")).toBe(true);
  expect(allows(await evaluateAccessPolicy(read, ctx("get")), "get")).toBe(true);

  const failing = async () => {
    throw new Error("policy boom");
  };
  await expect(evaluateAccessPolicy(failing, ctx("get"))).rejects.toThrow("policy boom");
});

test("context-only and schema-bound policies keep distinct brands", () => {
  const helper = createPolicyHelper<Ctx>();
  const contextOnly = helper(({ user }) => (user ? fullAccess : none));
  const schemaBound = helper(z.object({ name: z.string() }), () => fullAccess);
  const staticContext = helper({ reason: { code: "SIGN_IN_REQUIRED" } }, ({ user }) =>
    user ? fullAccess : none,
  );
  const staticSchema = helper(
    { schema: z.object({ locked: z.boolean() }), reason: { code: "LOCKED_ITEM" } },
    ({ doc }) => (doc?.locked ? none : fullAccess),
  );

  expect(isContextPolicy(contextOnly)).toBe(true);
  expect(isConstrainedPolicy(contextOnly)).toBe(false);
  expect(isConstrainedPolicy(schemaBound)).toBe(true);
  expect(isContextPolicy(schemaBound)).toBe(false);
  expect(isContextPolicy(staticContext)).toBe(true);
  expect(isConstrainedPolicy(staticSchema)).toBe(true);
  expect(isContextPolicy(fullAccess)).toBe(false);
  expect(isConstrainedPolicy(fullAccess)).toBe(false);
  expect(isAccessGrant(fullAccess)).toBe(true);
});

test("schema-bound and context-only policies retain literal reason codes", async () => {
  const helper = createPolicyHelper<Ctx>();
  const schemaBound = helper(
    {
      schema: z.object({ locked: z.boolean() }),
      reason: {
        code: "LOCKED_ITEM",
        description: "Locked items cannot be changed.",
      },
    },
    ({ doc }) => (doc?.locked ? none : fullAccess),
  );
  const contextOnly = helper({ reason: { code: "SIGN_IN_REQUIRED" } }, ({ user }) =>
    user ? fullAccess : none,
  );
  const accessContext: AccessContext<
    Ctx,
    { id: string; createdAt: string; updatedAt: string; locked: boolean }
  > = {
    tenantId: "t",
    user: { id: "u1" },
    collection: "items",
    operation: "invoke",
    permission: "invoke",
    doc: { id: "item-1", createdAt: "", updatedAt: "", locked: true },
  };

  const schemaDecision = await evaluateAccessPolicy(schemaBound, accessContext);
  const contextDecision = await evaluateAccessPolicy(contextOnly, {
    ...accessContext,
    user: null,
  });
  expect(denialReasonOf(schemaDecision, "invoke")).toEqual({
    code: "LOCKED_ITEM",
    description: "Locked items cannot be changed.",
  });
  expect(denialReasonOf(contextDecision, "invoke")).toEqual({
    code: "SIGN_IN_REQUIRED",
  });
});

test("and selects the first denying policy and keeps short-circuit order", async () => {
  const helper = createPolicyHelper<Ctx>();
  const calls: string[] = [];
  const firstDenied = helper({ reason: { code: "FIRST_DENIAL" } }, () => {
    calls.push("first");
    return none;
  });
  const secondDenied = helper({ reason: { code: "SECOND_DENIAL" } }, () => {
    calls.push("second");
    return none;
  });
  const firstDecision = await evaluateAccessPolicy(and(firstDenied, secondDenied), ctx("invoke"));
  expect(denialReasonOf(firstDecision, "invoke")).toEqual({ code: "FIRST_DENIAL" });
  expect(calls).toEqual(["first"]);

  const laterDecision = await evaluateAccessPolicy(
    and(
      helper({ reason: { code: "ALLOWING_POLICY" } }, () => fullAccess),
      secondDenied,
    ),
    ctx("invoke"),
  );
  expect(denialReasonOf(laterDecision, "invoke")).toEqual({ code: "SECOND_DENIAL" });

  const reasonlessDecision = await evaluateAccessPolicy(
    and(
      helper(() => none),
      helper({ reason: { code: "MUST_NOT_FALL_BACK" } }, () => none),
    ),
    ctx("invoke"),
  );
  expect(denialReasonOf(reasonlessDecision, "invoke")).toBeUndefined();
});

test("or selects the first policy only when every policy denies", async () => {
  const helper = createPolicyHelper<Ctx>();
  const firstDenied = helper({ reason: { code: "FIRST_DENIAL" } }, () => none);
  const secondDenied = helper({ reason: { code: "SECOND_DENIAL" } }, () => none);
  const denied = await evaluateAccessPolicy(or(firstDenied, secondDenied), ctx("invoke"));
  expect(denialReasonOf(denied, "invoke")).toEqual({ code: "FIRST_DENIAL" });

  const reasonless = await evaluateAccessPolicy(
    or(
      helper(() => none),
      secondDenied,
    ),
    ctx("invoke"),
  );
  expect(denialReasonOf(reasonless, "invoke")).toBeUndefined();

  const partiallyAllowed = await evaluateAccessPolicy(
    or(
      firstDenied,
      helper(() => grant("invoke")),
    ),
    ctx("invoke"),
  );
  expect(denialReasonOf(partiallyAllowed, "invoke")).toBeUndefined();

  const calls: string[] = [];
  await evaluateAccessPolicy(
    or(
      helper(() => {
        calls.push("first");
        return fullAccess;
      }),
      helper(() => {
        calls.push("second");
        return none;
      }),
    ),
    ctx("invoke"),
  );
  expect(calls).toEqual(["first"]);
});
