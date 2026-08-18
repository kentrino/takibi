import { expect, test } from "vite-plus/test";
import { allows, and, fullAccess, grant, none, or, read, write } from "../src/index";
import type { AccessContext, AccessGrant } from "../src/index";

type Ctx = { tenantId: string; user: { id: string } | null };

function ctx(permission: AccessContext<Ctx>["permission"]): AccessContext<Ctx> {
  return {
    tenantId: "t",
    user: { id: "u1" },
    collection: "items",
    operation: permission === "create" ? "add" : permission,
    permission,
  };
}

function actionsOf(grant: AccessGrant): string[] {
  return [...grant].sort();
}

test("allows checks the current permission against a grant", () => {
  expect(actionsOf(write)).toEqual(["create", "delete", "update"]);
  expect(allows(write, "delete")).toBe(true);
  expect(allows(write, "get")).toBe(false);
  expect(allows(write, "list")).toBe(false);
  expect(allows(write, "invoke")).toBe(false);
  expect(allows(read, "get")).toBe(true);
  expect(allows(read, "update")).toBe(false);
  expect(allows(none, "list")).toBe(false);
  expect(allows(grant("create"), "create")).toBe(true);
  expect(allows(grant("create"), "update")).toBe(false);
  for (const permission of ["create", "get", "list", "update", "delete", "invoke"] as const) {
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
  expect(actionsOf(readWrite)).toEqual(["create", "delete", "get", "list", "update"]);
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
