import { createClient } from "@takibi/takibi-client";
import { fullAccess } from "@takibi/takibi-policy";
import { createTakibi } from "@takibi/takibi-worker-runtime";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "../src";

test("SQLite test handlers inherit definitions without sharing storage", async () => {
  const context = createTakibi()({
    resolve: ({ request }) => ({ tenantId: request.headers.get("x-tenant") ?? "default" }),
  });
  const app = context.defineCollections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
      seed: () => ({ seeded: { title: "seeded" } }),
    },
  });
  const production = app.actions({});
  const first = withSqliteTestBackend(production);
  const second = withSqliteTestBackend(production);
  const firstClient = createClient<typeof production>("https://takibi.test", {
    fetch: (input, init) => first.request(input, init),
  });
  const secondClient = createClient<typeof production>("https://takibi.test", {
    fetch: (input, init) => second.request(input, init),
  });

  await firstClient.posts.add({ title: "first only" }, { id: "first-only" });

  await expect(firstClient.posts.get("seeded")).resolves.toMatchObject({
    ok: true,
    data: { id: "seeded", title: "seeded" },
  });
  await expect(secondClient.posts.get("seeded")).resolves.toMatchObject({
    ok: true,
    data: { id: "seeded", title: "seeded" },
  });
  await expect(secondClient.posts.get("first-only")).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(first[Symbol.dispose]).toBeTypeOf("function");
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  second[Symbol.dispose]();
});

test("SQLite test handlers isolate concurrent requests from rolled-back atomic actions", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = createTakibi()({ resolve: () => ({ tenantId: "test" }) });
  const app = context.defineCollections({
    posts: {
      schema: z.object({ title: z.string() }),
      accessPolicy: fullAccess,
    },
  });
  const failAfterWrite = app
    .defineAction()
    .atomic()
    .policy(fullAccess)
    .handler(async ({ $collections }) => {
      await $collections.posts.add({ title: "rolled back" }, { id: "rolled-back" });
      enter();
      await released;
      throw new Error("roll back");
    });
  const production = app.actions({ $: { failAfterWrite } });
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof production>("https://takibi.test", {
    fetch: (input, init) => handler.request(input, init),
  });

  const failing = client.failAfterWrite();
  await entered;
  let concurrentSettled = false;
  const concurrent = client.posts
    .add({ title: "preserved" }, { id: "preserved" })
    .then((result) => {
      concurrentSettled = true;
      return result;
    });
  await Promise.resolve();
  expect(concurrentSettled).toBe(false);

  release();
  await expect(failing).resolves.toMatchObject({ ok: false });
  await expect(concurrent).resolves.toMatchObject({ ok: true });
  await expect(client.posts.get("rolled-back")).resolves.toMatchObject({ ok: false });
  await expect(client.posts.get("preserved")).resolves.toMatchObject({
    ok: true,
    data: { title: "preserved" },
  });
  handler[Symbol.dispose]();
});

test("withSqliteTestBackend rejects a non-Takibi handler", () => {
  expect(() => {
    // @ts-expect-error a plain object is not a branded Takibi handler
    return withSqliteTestBackend({}, {});
  }).toThrow(new TypeError("Expected a Takibi handler created by createTakibi()"));
});

test("disposing one handler does not close another handler's storage", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const production = context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const first = withSqliteTestBackend(production);
  const second = withSqliteTestBackend(production);
  const secondClient = createClient<typeof production>("https://takibi.test", {
    fetch: (input, init) => second.request(input, init),
  });
  await secondClient.posts.add({ title: "kept" }, { id: "kept" });
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  await expect(secondClient.posts.get("kept")).resolves.toMatchObject({
    ok: true,
    data: { title: "kept" },
  });
  second[Symbol.dispose]();
});
