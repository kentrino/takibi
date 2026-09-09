import { requestTakibi } from "./helpers/request";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fullAccess } from "@takibi/takibi-policy";
import { createTakibi } from "@takibi/takibi-worker-runtime";
import {
  createInProcessRuntime,
  getTestingFork,
} from "@takibi/takibi-worker-runtime/testing-bridge";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "../src";

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
  expect(getTestingFork(handler)).toBeTypeOf("function");
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
  forked[Symbol.dispose]();
});

test("built testing package and runtime testing-bridge share one WeakMap", async () => {
  const testingDist = join(import.meta.dirname, "../dist/index.mjs");
  const runtimeDist = join(import.meta.dirname, "../../takibi-worker-runtime/dist/index.mjs");
  const bridgeDist = join(
    import.meta.dirname,
    "../../takibi-worker-runtime/dist/testing-bridge.mjs",
  );
  if (!existsSync(testingDist) || !existsSync(runtimeDist) || !existsSync(bridgeDist)) return;

  const testing = (await import(pathToFileURL(testingDist).href)) as typeof import("../src");
  const runtime = (await import(
    pathToFileURL(runtimeDist).href
  )) as typeof import("@takibi/takibi-worker-runtime");
  const bridge = (await import(
    pathToFileURL(bridgeDist).href
  )) as typeof import("@takibi/takibi-worker-runtime/testing-bridge");
  const handler = runtime
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
  const forked = testing.withSqliteTestBackend(handler);
  expect(forked[Symbol.dispose]).toBeTypeOf("function");
  forked[Symbol.dispose]();
});

test("createInProcessRuntime stays on the runtime bridge, not this package", () => {
  expect(typeof createInProcessRuntime).toBe("function");
});
