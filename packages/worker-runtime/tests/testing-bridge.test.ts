import { requestTakibi } from "./helpers/request";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "@takibi/testing";
import { fullAccess } from "@takibi/policy";
import { createTakibi } from "@takibi/worker-runtime";
import { assignTakibiBrand } from "../src/brand";
import {
  createInProcessRuntime,
  getTestingFork,
  registerTestingFork,
} from "@takibi/worker-runtime/testing-bridge";

test("createTakibi registers a testing fork on the shared WeakMap", () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});

  expect(getTestingFork(handler)).toBeTypeOf("function");
});

test("withSqliteTestBackend looks up the same WeakMap registration", async () => {
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const forked = withSqliteTestBackend(handler);
  const response = await requestTakibi(forked, "https://takibi.test/posts/p1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "via-bridge" }),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    data: { title: "via-bridge" },
  });
});

test("register and get share one WeakMap even across duplicate module evaluation", () => {
  const target = { id: "probe", [Symbol.dispose]() {} };
  const handler = assignTakibiBrand<typeof target, {}, {}, object>(target, {
    collections: {},
    actions: {},
  });
  const fork = () => handler;
  registerTestingFork(handler, fork);
  expect(getTestingFork(handler)).toBe(fork);
});

test("built testing-bridge and root share one WeakMap instance", async () => {
  const distDir = join(import.meta.dirname, "../dist");
  const rootPath = join(distDir, "index.mjs");
  const bridgePath = join(distDir, "testing-bridge.mjs");
  if (!existsSync(rootPath) || !existsSync(bridgePath)) return;

  const root = (await import(pathToFileURL(rootPath).href)) as typeof import("@takibi/worker-runtime");
  const bridge = (await import(
    pathToFileURL(bridgePath).href
  )) as typeof import("@takibi/worker-runtime/testing-bridge");
  const handler = root
    .createTakibi()({
      resolve: () => ({ tenantId: "built" }),
    })
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  expect(bridge.getTestingFork(handler)).toBeTypeOf("function");
});

test("createInProcessRuntime is the high-level testing assembly function", () => {
  expect(typeof createInProcessRuntime).toBe("function");
});
