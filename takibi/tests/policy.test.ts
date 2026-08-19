import { expect, expectTypeOf, test } from "vite-plus/test";
import { and, fullAccess, grant, none, or, read, write } from "../src/index";
import { allows } from "../src/policy";
import type { AccessContext, AccessGrant, AccessPermission } from "../src/index";

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
