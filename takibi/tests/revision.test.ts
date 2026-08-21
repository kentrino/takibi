import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createClient } from "@takibi/takibi/client";
import { createTakibi, fullAccess } from "../src/index";
import { createDurableObjectStorage, createMemoryStorage } from "../src/storage";
import type { StoredDocument } from "../src/types";
import { createSqliteDurableObjectStorage } from "./sqlite";

type AppCtx = { tenantId: string };

function createApp(options?: { memory?: boolean }) {
  const context = createTakibi()({ resolve: (): AppCtx => ({ tenantId: "tenant-a" }) });
  return context
    .defineCollections(
      {
        posts: {
          schema: z.object({ title: z.string() }),
          accessPolicy: fullAccess,
        },
      },
      options,
    )
    .actions({});
}

function clientOf(handler: ReturnType<typeof createApp>) {
  return createClient<typeof handler>("http://fire.test", { fetch: handler.request });
}

test("add and create-via-set start at rev 1 and successful writes increment", async () => {
  const client = clientOf(createApp({ memory: true }));
  const created = await client.posts.add({ title: "one" });
  expect(created).toMatchObject({ ok: true, data: { title: "one", rev: 1 } });
  if (!created.ok) return;

  const replaced = await client.posts.set(created.data.id, { title: "two", rev: 1 });
  expect(replaced).toMatchObject({ ok: true, data: { title: "two", rev: 2 } });

  const patched = await client.posts.update(created.data.id, { title: "three", rev: 2 });
  expect(patched).toMatchObject({ ok: true, data: { title: "three", rev: 3 } });
});

test("a stale rev is rejected and leaves the document unchanged", async () => {
  const client = clientOf(createApp({ memory: true }));
  const created = await client.posts.add({ title: "one" }, { id: "p1" });
  expect(created.ok).toBe(true);

  const first = await client.posts.set("p1", { title: "two", rev: 1 });
  expect(first).toMatchObject({ ok: true, data: { title: "two", rev: 2 } });

  const stale = await client.posts.set("p1", { title: "lost", rev: 1 });
  expect(stale).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "STALE_WRITE", status: 409 },
  });

  const got = await client.posts.get("p1");
  expect(got).toMatchObject({ ok: true, data: { title: "two", rev: 2 } });
});

test("rev on a missing document is a stale write", async () => {
  const client = clientOf(createApp({ memory: true }));
  const missing = await client.posts.set("missing", { title: "ghost", rev: 1 });
  expect(missing).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "STALE_WRITE", status: 409 },
  });
});

test("omitting rev is last-write-wins and still increments", async () => {
  const client = clientOf(createApp({ memory: true }));
  const created = await client.posts.add({ title: "one" }, { id: "p1" });
  expect(created.ok).toBe(true);

  const replaced = await client.posts.set("p1", { title: "two" });
  expect(replaced).toMatchObject({ ok: true, data: { title: "two", rev: 2 } });
});

test("add rejects rev in input", async () => {
  const client = clientOf(createApp({ memory: true }));
  const added = await client.posts.add({ title: "one", rev: 1 } as { title: string });
  expect(added).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
});

test("documents stored without rev read as 1 and the next write stores 2", async () => {
  const memory = createMemoryStorage();
  const legacy = {
    id: "legacy",
    title: "old",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as unknown as StoredDocument;
  await memory.put("posts", legacy);
  expect(await memory.get("posts", "legacy")).toMatchObject({ title: "old", rev: 1 });

  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
  await durable.put("posts", legacy);
  expect(await durable.get("posts", "legacy")).toMatchObject({ title: "old", rev: 1 });
});
