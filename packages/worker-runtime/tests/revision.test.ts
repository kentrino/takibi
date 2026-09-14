import { requestTakibi } from "./helpers/request";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createClient } from "@takibi/client";
import { withSqliteTestBackend } from "@takibi/testing";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import { createDurableObjectStorage } from "@takibi/storage";
import { fullAccess, none } from "@takibi/policy";
import { createTakibi, nextDocumentRevision, storageSet } from "@takibi/worker-runtime";
import type { StoredDocument } from "@takibi/storage";

type AppCtx = { tenantId: string };

function createApp() {
  const context = createTakibi()({ resolve: (): AppCtx => ({ tenantId: "tenant-a" }) });
  const production = context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  return withSqliteTestBackend(production);
}

function clientOf(handler: ReturnType<typeof createApp>) {
  return createClient<typeof handler>("http://fire.test", {
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
}

test("add and create-via-set start at rev 1 and successful writes increment", async () => {
  const client = clientOf(createApp());
  const created = await client.posts.add({ title: "one" });
  expect(created).toMatchObject({ ok: true, data: { title: "one", rev: 1 } });
  if (!created.ok) return;

  const replaced = await client.posts.set(created.data.id, { title: "two", rev: 1 });
  expect(replaced).toMatchObject({ ok: true, data: { title: "two", rev: 2 } });

  const patched = await client.posts.update(created.data.id, { title: "three", rev: 2 });
  expect(patched).toMatchObject({ ok: true, data: { title: "three", rev: 3 } });
});

test("a stale rev is rejected and leaves the document unchanged", async () => {
  const client = clientOf(createApp());
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
  const client = clientOf(createApp());
  const missing = await client.posts.set("missing", { title: "ghost", rev: 1 });
  expect(missing).toMatchObject({
    ok: false,
    error: { kind: "operation", code: "STALE_WRITE", status: 409 },
  });
});

test("omitting rev is last-write-wins and still increments", async () => {
  const client = clientOf(createApp());
  const created = await client.posts.add({ title: "one" }, { id: "p1" });
  expect(created.ok).toBe(true);

  const replaced = await client.posts.set("p1", { title: "two" });
  expect(replaced).toMatchObject({ ok: true, data: { title: "two", rev: 2 } });
});

test("concurrent revision-checked updates serialize policy and reject the stale writer", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updatePolicies = 0;
  const context = createTakibi()({ resolve: (): AppCtx => ({ tenantId: "tenant-a" }) });
  const production = context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        async accessPolicy(access) {
          if (access.operation === "update" && updatePolicies++ === 0) {
            enter();
            await released;
          }
          return fullAccess;
        },
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof production>("http://fire.test", {
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  await client.posts.add({ title: "one" }, { id: "p1" });

  const first = client.posts.update("p1", { title: "first", rev: 1 });
  await entered;
  let secondSettled = false;
  const second = client.posts.update("p1", { title: "second", rev: 1 }).then((result) => {
    secondSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(secondSettled).toBe(false);
  release();

  await expect(first).resolves.toMatchObject({ ok: true, data: { title: "first", rev: 2 } });
  await expect(second).resolves.toMatchObject({
    ok: false,
    error: { code: "STALE_WRITE" },
  });
  await expect(client.posts.get("p1")).resolves.toMatchObject({
    ok: true,
    data: { title: "first", rev: 2 },
  });
  handler[Symbol.dispose]();
});

test("concurrent last-write-wins updates derive consecutive revisions", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updatePolicies = 0;
  const context = createTakibi()({ resolve: (): AppCtx => ({ tenantId: "tenant-a" }) });
  const production = context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        async accessPolicy(access) {
          if (access.operation === "update" && updatePolicies++ === 0) {
            enter();
            await released;
          }
          return fullAccess;
        },
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof production>("http://fire.test", {
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  await client.posts.add({ title: "one" }, { id: "p1" });

  const first = client.posts.update("p1", { title: "first" });
  await entered;
  const second = client.posts.update("p1", { title: "second" });
  release();

  await expect(first).resolves.toMatchObject({ ok: true, data: { rev: 2 } });
  await expect(second).resolves.toMatchObject({ ok: true, data: { title: "second", rev: 3 } });
  await expect(client.posts.get("p1")).resolves.toMatchObject({
    ok: true,
    data: { title: "second", rev: 3 },
  });
  handler[Symbol.dispose]();
});

test("a racing delete evaluates policy against the update it follows", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updatePolicies = 0;
  const context = createTakibi()({ resolve: (): AppCtx => ({ tenantId: "tenant-a" }) });
  const production = context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        async accessPolicy(access) {
          if (access.operation === "update" && updatePolicies++ === 0) {
            enter();
            await released;
          }
          if (access.operation === "delete") {
            return (access.doc as { title?: unknown } | undefined)?.title === "before"
              ? fullAccess
              : none;
          }
          return fullAccess;
        },
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const client = createClient<typeof production>("http://fire.test", {
    fetch: (input, init) => requestTakibi(handler, input, init),
  });
  await client.posts.add({ title: "before" }, { id: "p1" });

  const update = client.posts.update("p1", { title: "after", rev: 1 });
  await entered;
  let deleteSettled = false;
  const deletion = client.posts.delete("p1").then((result) => {
    deleteSettled = true;
    return result;
  });
  await Promise.resolve();
  expect(deleteSettled).toBe(false);
  release();

  await expect(update).resolves.toMatchObject({ ok: true, data: { title: "after", rev: 2 } });
  await expect(deletion).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  await expect(client.posts.get("p1")).resolves.toMatchObject({
    ok: true,
    data: { title: "after", rev: 2 },
  });
  handler[Symbol.dispose]();
});

test("add rejects rev in input", async () => {
  const client = clientOf(createApp());
  const added = await client.posts.add({ title: "one", rev: 1 } as { title: string });
  expect(added).toMatchObject({
    ok: false,
    error: { kind: "validation", code: "VALIDATION", status: 400 },
  });
});

test("SQLite documents stored without rev read as revision 1", async () => {
  const legacy = {
    id: "legacy",
    title: "old",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as unknown as StoredDocument;
  const durable = createDurableObjectStorage(createSqliteDurableObjectStorage());
  await durable.put("posts", legacy);
  expect(await durable.get("posts", "legacy")).toMatchObject({ title: "old", rev: 1 });
});

test("SQLite-backed updates advance revisions beyond numeric storage boundaries", async () => {
  const storage = createDurableObjectStorage(createSqliteDurableObjectStorage());
  const definition = {
    schema: z.object({ title: z.string() }),
    accessPolicy: fullAccess,
  };

  for (const current of [2 ** 53, 2 ** 63]) {
    const id = `p-${String(current)}`;
    await storage.put("posts", {
      id,
      title: "old",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      rev: current,
    });

    const updated = await storageSet(definition, storage, "posts", id, {
      title: "new",
      rev: current,
    });
    expect(updated.rev).toBe(nextDocumentRevision(current));
    await expect(storage.get("posts", id)).resolves.toMatchObject({
      title: "new",
      rev: nextDocumentRevision(current),
    });
  }
});

test("nextDocumentRevision advances past IEEE-754 identity", () => {
  expect(nextDocumentRevision(1)).toBe(2);
  expect(nextDocumentRevision(2 ** 53)).toBeGreaterThan(2 ** 53);
  expect(nextDocumentRevision(2 ** 63)).toBeGreaterThan(2 ** 63);
});
