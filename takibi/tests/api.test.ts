/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import * as Api from "@takibi/takibi-api";
import * as Policy from "@takibi/takibi-policy";
import { createClient } from "@takibi/takibi/client";
import { withSqliteTestBackend } from "@takibi/takibi/testing";
import {
  AlreadyExistsError,
  ListAllLimitError,
  StaleWriteError,
  TakibiError,
  createTakibi,
} from "../src/index";

test("direct API package and Takibi facade share error class identity", () => {
  expect(Api.TakibiError).toBe(TakibiError);
  expect(Api.AlreadyExistsError).toBe(AlreadyExistsError);
  expect(Api.StaleWriteError).toBe(StaleWriteError);
  expect(Api.ListAllLimitError).toBe(ListAllLimitError);
  expect(new AlreadyExistsError()).toBeInstanceOf(Api.TakibiError);
});

test("built Takibi facade recognizes errors from the API package specifier", async () => {
  const takibiDist = join(import.meta.dirname, "../dist/index.mjs");
  if (!existsSync(takibiDist)) return;
  const js = readFileSync(takibiDist, "utf8");
  if (!js.includes("@takibi/takibi-api")) return;

  const TakibiBuilt = await import(pathToFileURL(takibiDist).href);
  expect(js).toMatch(/@takibi\/takibi-api/);
  expect(TakibiBuilt.TakibiError).toBe(Api.TakibiError);
  expect(new TakibiBuilt.AlreadyExistsError()).toBeInstanceOf(Api.AlreadyExistsError);
});

test("createTakibi consumes API-owned builders and policy-owned grants", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "t", user: { id: "u1" } }),
  });
  const posts = context.defineCollection({
    schema: z.object({ title: z.string() }),
    accessPolicy: Policy.fullAccess,
  });
  const app = context.defineCollections({ posts });
  const postsActions = app.posts.actions((defineAction) => ({
    ping: defineAction()
      .detached()
      .policy(Policy.grant("invoke"))
      .handler(() => ({ ok: true as const })),
  }));
  const handler = withSqliteTestBackend(app.actions({ posts: postsActions }));
  const client = createClient<typeof handler>("http://takibi.test", {
    fetch: (input, init) => handler.request(input, init),
  });
  const added = await client.posts.add({ title: "hello" }, { id: "p1" });
  expect(added).toMatchObject({ ok: true });
  const pinged = await client.posts.ping();
  expect(pinged).toMatchObject({ ok: true, data: { ok: true } });
  expectTypeOf(client.posts.ping).returns.resolves.toHaveProperty("ok");
});
