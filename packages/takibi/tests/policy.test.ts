import { requestTakibi } from "./helpers/request";
/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import * as Policy from "@takibi/policy";
import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import { and, createTakibi, fullAccess, grant, none, or, read, write } from "../src/index";
import type { AccessContext } from "../src/index";
import { allows, isAccessGrant, permissionsOf } from "../src/policy";

type Ctx = { tenantId: string; user: { id: string } };

function ctx(permission: AccessContext<Ctx>["permission"]): AccessContext<Ctx> {
  return {
    tenantId: "t",
    user: { id: "u1" },
    collection: "items",
    operation: permission === "create" ? "add" : permission,
    permission,
  };
}

test("public root still exports grant combinators and predefined grants", async () => {
  expect(allows(write, "delete")).toBe(true);
  expect(allows(read, "get")).toBe(true);
  expect(allows(none, "list")).toBe(false);
  expect(allows(grant("create"), "create")).toBe(true);
  expect(allows(await and(() => fullAccess, read)(ctx("get")), "get")).toBe(true);
  expect(allows(await or(none, grant("create"))(ctx("create")), "create")).toBe(true);
});

test("direct policy package and Takibi facade share WeakMap-backed grant identity", () => {
  expect(none).toBe(Policy.none);
  expect(read).toBe(Policy.read);
  expect(write).toBe(Policy.write);
  expect(fullAccess).toBe(Policy.fullAccess);

  const direct = Policy.grant("get", "invoke");
  const facade = grant("get", "invoke");
  expect(isAccessGrant(direct)).toBe(true);
  expect(Policy.isAccessGrant(facade)).toBe(true);
  expect(allows(direct, "invoke")).toBe(true);
  expect(Policy.allows(facade, "get")).toBe(true);
  expect([...permissionsOf(direct)]).toEqual([...Policy.permissionsOf(facade)]);
  expect(Policy.isAccessGrant({})).toBe(false);
  expect(isAccessGrant(new Set(["get"]))).toBe(false);
});

test("built Takibi facade recognizes grants from the policy package specifier", async () => {
  const takibiDist = join(import.meta.dirname, "../dist/index.mjs");
  if (!existsSync(takibiDist)) return;
  const js = readFileSync(takibiDist, "utf8");
  if (!js.includes("@takibi/policy")) return;

  const TakibiBuilt = await import(pathToFileURL(takibiDist).href);
  expect(js).toMatch(/@takibi\/policy/);
  expect(Policy.isAccessGrant(TakibiBuilt.grant("get"))).toBe(true);
  expect(Policy.allows(TakibiBuilt.fullAccess, "invoke")).toBe(true);
  expect(isAccessGrant(TakibiBuilt.write)).toBe(true);
});

test("collection and action policies accept direct-package grants", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t" }),
  });
  const app = context.defineCollections({
    items: {
      schema: z.object({ name: z.string() }),
      accessPolicy: Policy.fullAccess,
    },
  });
  const actions = app.items.actions((defineAction) => ({
    ping: defineAction()
      .policy(Policy.grant("invoke"))
      .handler(({ id }) => ({ id })),
  }));
  const handler = withSqliteTestBackend(app.actions({ items: actions }));
  const client = createClient<typeof handler>("http://takibi.test", {
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  const created = await client.items.add({ name: "alpha" }, { id: "item-1" });
  expect(created.ok).toBe(true);
  const pinged = await client.items.ping("item-1");
  expect(pinged).toEqual({ ok: true, data: { id: "item-1" } });
});
