import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import {
  ActionRegistry,
  defineCollection,
  MaintenanceLockedError,
  type CollectionsDef,
} from "@takibi/api";
import { fullAccess } from "@takibi/policy";
import { SqlExecutor, sqlCommitOutcomeUnknown, type SqlStatementExecutor } from "@takibi/storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";
import { createTrustedCollections, TRUSTED_COLLECTION_METHODS } from "../src/executor";
import { createTenantRuntime, type TenantHost } from "../src/tenant-runtime";
import type { WatchHost, WatchSocket } from "../src/watch-runtime";

// The runtime runs here on node:sqlite with plain in-memory hosts: no Durable
// Object state, storage double, or Cloudflare globals.

const definitions = {
  posts: defineCollection({
    schema: z.object({ title: z.string(), score: z.number() }),
    accessPolicy: fullAccess,
    indexes: { byScore: ["score"] },
    seed: async () => ({ welcome: { title: "hello", score: 1 } }),
  }),
};
// `CollectionsDef` erases schemas, and its `unique`/`indexes` key types then
// evaluate to `never`, so typed definitions need this one explicit widening.
const collections = definitions as unknown as CollectionsDef;

function recordingSql(): { sql: SqlExecutor; statements: string[]; close: () => void } {
  const inner = createNodeSqliteExecutor();
  const statements: string[] = [];
  const record = (executor: SqlStatementExecutor): SqlStatementExecutor => ({
    exec(query, ...bindings) {
      statements.push(query.replace(/\s+/g, " ").trim());
      return executor.exec(query, ...bindings);
    },
  });
  const sql = new SqlExecutor({
    ...record(inner),
    transaction: (callback) => inner.transaction((scoped) => callback(record(scoped))),
  });
  return { sql, statements, close: () => inner.close() };
}

function immediateHost(watch?: WatchHost): TenantHost & { startups: number } {
  const host = {
    startups: 0,
    runStartup(startup: () => Promise<void>) {
      host.startups += 1;
      return startup();
    },
    watch,
  };
  return host;
}

function runtimeOver(host: TenantHost, sql: SqlExecutor) {
  return createTenantRuntime({
    collections,
    registry: new ActionRegistry(),
    logger: undefined,
    services: {},
    sql,
    host,
  });
}

const getWelcome = {
  kind: "collection",
  collection: "posts",
  operation: "get",
  id: "welcome",
} as const;

function execution() {
  return {
    request: new Request("https://tenant.test/"),
    traced: false,
    spanKind: "internal" as const,
    parentSpan: undefined,
  };
}

test("startup runs once through the host in the documented order", async () => {
  const { sql, statements, close } = recordingSql();
  const host = immediateHost();
  const runtime = runtimeOver(host, sql);
  await runtime.ready;
  close();
  expect(host.startups).toBe(1);
  const first = (pattern: RegExp) => {
    const index = statements.findIndex((statement) => pattern.test(statement));
    expect(index, String(pattern)).toBeGreaterThanOrEqual(0);
    return index;
  };
  const order = [
    first(/CREATE TABLE IF NOT EXISTS takibi_metadata/),
    first(/CREATE TABLE IF NOT EXISTS takibi_maintenance_lease/),
    first(/DELETE FROM takibi_maintenance_lease/),
    first(/CREATE INDEX IF NOT EXISTS/),
    first(/INSERT INTO takibi_documents/),
  ];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  // Each layout is initialised exactly once, by startup.
  const count = (pattern: RegExp) => statements.filter((statement) => pattern.test(statement));
  expect(count(/CREATE TABLE IF NOT EXISTS takibi_metadata/)).toHaveLength(1);
  expect(count(/CREATE TABLE IF NOT EXISTS takibi_maintenance_lease/)).toHaveLength(1);
});

test("a request executes against seeded data after startup", async () => {
  const { sql, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  const response = await runtime.execute(execution(), (local) => local.execute({}, getWelcome));
  close();
  expect(response).toMatchObject({ ok: true, data: { id: "welcome", title: "hello", rev: 1 } });
});

test("startup failure reaches the host and every later execution", async () => {
  const failure = new Error("layout failed");
  const sql = new SqlExecutor({
    exec: async () => {
      throw failure;
    },
    transaction: async () => {
      throw failure;
    },
  });
  const runtime = runtimeOver(immediateHost(), sql);
  await expect(runtime.ready).rejects.toBe(failure);
  await expect(runtime.execute(execution(), async () => "unreached")).rejects.toBe(failure);
});

test("requests are rejected while a maintenance lease is held and resume after it", async () => {
  const { sql, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  const exported = await runtime.collectionsApi.$exportSnapshot();
  await expect(
    runtime.execute(execution(), (local) => local.execute({}, getWelcome)),
  ).rejects.toBeInstanceOf(MaintenanceLockedError);
  await new Response(exported).arrayBuffer();
  await expect(
    runtime.execute(execution(), (local) => local.execute({}, getWelcome)),
  ).resolves.toMatchObject({ ok: true });
  close();
});

test("without a watch host, upgrades are unavailable and socket events are ignored", async () => {
  const { sql, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  await expect(runtime.upgradeWatch(new Request("https://tenant.test/"))).rejects.toMatchObject({
    code: "WATCH_UNAVAILABLE",
  });
  const socketSend = vi.fn();
  const socketClose = vi.fn();
  const socket: WatchSocket = {
    readyState: 1,
    send: socketSend,
    close: socketClose,
    deserializeAttachment: () => undefined,
  };
  runtime.watchMessage(socket);
  runtime.watchClose(socket, 1011);
  expect(socketSend).not.toHaveBeenCalled();
  expect(socketClose).not.toHaveBeenCalled();
  close();
});

test("a watch host receives recovery and commit fan-out through the runtime", async () => {
  const { sql, close } = recordingSql();
  const pending: Promise<unknown>[] = [];
  const socket = {
    readyState: 1,
    send: vi.fn<(message: string) => void>(),
    close: vi.fn(),
    deserializeAttachment: () =>
      JSON.stringify({
        version: 1,
        collection: "posts",
        list: { limit: 10 },
        context: {},
      }),
  };
  const watch: WatchHost = {
    sockets: () => [socket],
    accept: () => {
      throw new Error("not used");
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const runtime = runtimeOver(immediateHost(watch), sql);
  await runtime.ready;
  await drain();
  // Recovery (and the seed commit) push the current list to the live socket.
  expect(JSON.parse(socket.send.mock.lastCall![0])).toMatchObject({
    kind: "snapshot",
    items: [{ id: "welcome" }],
  });
  const sentAfterStartup = socket.send.mock.calls.length;

  await runtime.collectionsApi.posts.add({ title: "second", score: 2 }, { id: "second" });
  await drain();
  expect(socket.send).toHaveBeenCalledTimes(sentAfterStartup + 1);
  expect(JSON.parse(socket.send.mock.lastCall![0]).items).toHaveLength(2);
  expect(socket.close).not.toHaveBeenCalled();
  close();
});

test("an unknown commit outcome reaches the caller unchanged and still fans out to watch", async () => {
  const inner = createNodeSqliteExecutor();
  const unknown = sqlCommitOutcomeUnknown(new Error("acknowledgement lost"));
  let armed = false;
  // Once armed, the next commit succeeds, but its acknowledgement is lost.
  const sql = new SqlExecutor({
    exec: (query, ...bindings) => inner.exec(query, ...bindings),
    async transaction(body) {
      const result = await inner.transaction(body);
      if (armed) {
        armed = false;
        throw unknown;
      }
      return result;
    },
  });
  const pending: Promise<unknown>[] = [];
  const socket = {
    readyState: 1,
    send: vi.fn<(message: string) => void>(),
    close: vi.fn(),
    deserializeAttachment: () =>
      JSON.stringify({ version: 1, collection: "posts", list: { limit: 10 }, context: {} }),
  };
  const watch: WatchHost = {
    sockets: () => [socket],
    accept: () => {
      throw new Error("not used");
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  const runtime = runtimeOver(immediateHost(watch), sql);
  await runtime.ready;
  await drain();
  const sentAfterStartup = socket.send.mock.calls.length;

  armed = true;
  let calls = 0;
  await expect(
    runtime.collectionsApi.$transaction(async (tx) => {
      calls += 1;
      await tx.posts.add({ title: "second", score: 2 }, { id: "second" });
    }),
  ).rejects.toBe(unknown);
  expect(calls).toBe(1);
  await drain();
  // Not treated as "nothing changed": subscribers re-read and see the write.
  expect(socket.send).toHaveBeenCalledTimes(sentAfterStartup + 1);
  expect(JSON.parse(socket.send.mock.lastCall![0]).items).toHaveLength(2);

  const response = await runtime.execute(execution(), (local) =>
    local.execute({}, { ...getWelcome, id: "second" }),
  );
  expect(response).toMatchObject({ ok: true, data: { id: "second" } });
  await runtime.close();
  inner.close();
});

function gatedHost(): TenantHost & { release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    release: () => release(),
    async runStartup(startup) {
      await gate;
      return startup();
    },
  };
}

test("the collections API exists before startup and its calls wait for startup", async () => {
  const { sql, statements, close } = recordingSql();
  const host = gatedHost();
  const runtime = runtimeOver(host, sql);
  // Same shape as the trusted collections startup builds over the database.
  const trusted = createTrustedCollections(collections, {} as never);
  expect(Object.keys(runtime.collectionsApi).sort()).toEqual(Object.keys(trusted).sort());
  expect(Object.keys(runtime.collectionsApi.posts).sort()).toEqual(
    Object.keys(trusted.posts!).sort(),
  );
  expect([...TRUSTED_COLLECTION_METHODS].sort()).toEqual(Object.keys(trusted.posts!).sort());

  const reading = runtime.collectionsApi.posts.get("welcome");
  const pending = watchSettled(reading);
  await tick();
  expect(pending.state.settled).toBe(false);
  expect(statements).toHaveLength(0);
  host.release();
  await expect(reading).resolves.toMatchObject({ id: "welcome", title: "hello" });
  await runtime.close();
  close();
});

test("close waits for startup, then rejects new work without touching the database", async () => {
  const { sql, statements, close } = recordingSql();
  const host = gatedHost();
  const runtime = runtimeOver(host, sql);
  let closed = false;
  const closing = runtime.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(closed).toBe(false);
  host.release();
  await closing;
  expect(statements.some((statement) => /takibi_metadata/.test(statement))).toBe(true);
  const issued = statements.length;
  await expect(runtime.execute(execution(), async () => "unreached")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  await expect(runtime.collectionsApi.posts.get("welcome")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  expect(statements).toHaveLength(issued);
  close();
});

test("close waits for in-flight executions", async () => {
  const { sql, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  await runtime.ready;
  let release!: () => void;
  const running = runtime.execute(execution(), async (local) => {
    await new Promise<void>((resolve) => (release = resolve));
    return local.execute({}, getWelcome);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let closed = false;
  const closing = runtime.close().then(() => (closed = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(closed).toBe(false);
  release();
  await expect(running).resolves.toMatchObject({ ok: true });
  await closing;
  close();
});

test("close rejects with a startup failure no call reported; repeated calls share that one outcome", async () => {
  const failure = new Error("seed failed");
  const failing: CollectionsDef = {
    posts: { ...collections.posts!, seed: async () => Promise.reject(failure) },
  };
  const unobserved = createTenantRuntime({
    collections: failing,
    registry: new ActionRegistry(),
    logger: undefined,
    services: {},
    sql: createNodeSqliteExecutor(),
    host: immediateHost(),
  });
  // close() is idempotent: every call returns the one promise that reports the failure.
  expect(unobserved.close()).toBe(unobserved.close());
  await expect(unobserved.close()).rejects.toBe(failure);
  await expect(unobserved.close()).rejects.toBe(failure);

  const observed = createTenantRuntime({
    collections: failing,
    registry: new ActionRegistry(),
    logger: undefined,
    services: {},
    sql: createNodeSqliteExecutor(),
    host: immediateHost(),
  });
  await expect(observed.execute(execution(), async () => "unreached")).rejects.toBe(failure);
  await expect(observed.close()).resolves.toBeUndefined();
});

test("a startup failure observed by a snapshot operation is not reported again by close", async () => {
  const failure = new Error("seed failed");
  const runtime = createTenantRuntime({
    collections: { posts: { ...collections.posts!, seed: async () => Promise.reject(failure) } },
    registry: new ActionRegistry(),
    logger: undefined,
    services: {},
    sql: createNodeSqliteExecutor(),
    host: immediateHost(),
  });
  await expect(runtime.collectionsApi.$resetAll()).rejects.toBe(failure);
  await expect(runtime.close()).resolves.toBeUndefined();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Resolves `settled` only once `promise` settled; for asserting that close() is still pending. */
function watchSettled(promise: Promise<unknown>) {
  const state = { settled: false };
  const done = promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return { state, done };
}

test("close waits for an in-flight trusted collections call and refuses new ones", async () => {
  const { sql, statements, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  await runtime.ready;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const running = runtime.collectionsApi.$transaction(async ($collections) => {
    await held;
    return $collections.posts.update("welcome", { title: "updated" });
  });
  await tick();
  const closing = watchSettled(runtime.close());
  await tick();
  expect(closing.state.settled).toBe(false);
  await expect(runtime.collectionsApi.posts.get("welcome")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  await expect(runtime.collectionsApi.$transaction(async () => "unreached")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  release();
  await expect(running).resolves.toMatchObject({ id: "welcome", title: "updated" });
  await closing.done;
  const issued = statements.length;
  await tick();
  expect(statements).toHaveLength(issued);
  close();
});

test("close waits for an in-flight snapshot restore and refuses new snapshot operations", async () => {
  const { sql, statements, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  const encoded = await new Response(await runtime.collectionsApi.$exportSnapshot()).text();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const restoring = runtime.collectionsApi.$restoreSnapshot(
    new ReadableStream<Uint8Array>({ start: (controller) => void (source = controller) }),
  );
  await tick();
  const closing = watchSettled(runtime.close());
  await tick();
  expect(closing.state.settled).toBe(false);
  await expect(runtime.collectionsApi.$resetAll()).rejects.toMatchObject({ code: "TENANT_CLOSED" });
  await expect(runtime.collectionsApi.$exportSnapshot()).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  // The restore still holds its maintenance lease; closing is reported first,
  // as for `execute`, not the lease.
  await expect(runtime.collectionsApi.posts.get("welcome")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  await expect(runtime.collectionsApi.$transaction(async () => "unreached")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  await expect(runtime.execute(execution(), async () => "unreached")).rejects.toMatchObject({
    code: "TENANT_CLOSED",
  });
  source.enqueue(new TextEncoder().encode(encoded));
  source.close();
  await expect(restoring).resolves.toMatchObject({ documentsRestored: 1 });
  await closing.done;
  const issued = statements.length;
  await tick();
  expect(statements).toHaveLength(issued);
  close();
});

test("close cancels an open export stream, releasing its lease, and later reads are refused", async () => {
  const { sql, statements, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  const stream = await runtime.collectionsApi.$exportSnapshot();
  await runtime.close();
  expect(statements.at(-1)).toMatch(/^DELETE FROM takibi_maintenance_lease WHERE lease_key = \?/);
  const issued = statements.length;
  await expect(new Response(stream).text()).rejects.toMatchObject({ code: "TENANT_CLOSED" });
  expect(statements).toHaveLength(issued);
  close();
});

test("close after reading part of an export stream leaves no read running against the database", async () => {
  const { sql, statements, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  const reader = (await runtime.collectionsApi.$exportSnapshot()).getReader();
  await expect(reader.read()).resolves.toMatchObject({ done: false });
  await runtime.close();
  expect(statements.at(-1)).toMatch(/^DELETE FROM takibi_maintenance_lease WHERE lease_key = \?/);
  const issued = statements.length;
  // Nothing started before close() may reach the database afterwards.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(statements).toHaveLength(issued);
  await expect(reader.read()).rejects.toMatchObject({ code: "TENANT_CLOSED" });
  expect(statements).toHaveLength(issued);
  close();
});

test("an export stream cancelled during a read releases its lease only after that read", async () => {
  const { sql, statements, close } = recordingSql();
  const runtime = runtimeOver(immediateHost(), sql);
  const reader = (await runtime.collectionsApi.$exportSnapshot()).getReader();
  await reader.read(); // header
  const reading = reader.read(); // scans the first page
  const cancelled = reader.cancel();
  await Promise.allSettled([reading, cancelled]);
  const releases = statements.filter((statement) =>
    statement.startsWith("DELETE FROM takibi_maintenance_lease WHERE lease_key = ?"),
  );
  expect(releases).toHaveLength(1);
  expect(statements.at(-1)).toBe(releases[0]);
  await runtime.close();
  close();
});

test("close waits for watch fan-out still pending in waitUntil", async () => {
  const inner = createNodeSqliteExecutor();
  let hold: Promise<void> | undefined;
  const statements: string[] = [];
  const gated = (executor: SqlStatementExecutor): SqlStatementExecutor => ({
    async exec(query, ...bindings) {
      statements.push(query);
      // The watch snapshot is the only ordered list read in this test.
      if (hold && /ORDER BY/.test(query)) await hold;
      return executor.exec(query, ...bindings);
    },
  });
  const sql = new SqlExecutor({
    ...gated(inner),
    transaction: (callback) => inner.transaction((scoped) => callback(gated(scoped))),
  });
  const socket = {
    readyState: 1,
    send: vi.fn<(message: string) => void>(),
    close: vi.fn(),
    deserializeAttachment: () =>
      JSON.stringify({ version: 1, collection: "posts", list: { limit: 10 }, context: {} }),
  };
  const pending: Promise<unknown>[] = [];
  const runtime = runtimeOver(
    immediateHost({
      sockets: () => [socket],
      accept: () => {
        throw new Error("not used");
      },
      waitUntil: (promise) => void pending.push(promise),
    }),
    sql,
  );
  await runtime.ready;
  while (pending.length) await Promise.all(pending.splice(0));
  const sentAfterStartup = socket.send.mock.calls.length;

  let release!: () => void;
  hold = new Promise<void>((resolve) => (release = resolve));
  await runtime.collectionsApi.posts.add({ title: "second", score: 2 }, { id: "second" });
  expect(pending.length).toBeGreaterThan(0);
  const closing = watchSettled(runtime.close());
  await tick();
  expect(closing.state.settled).toBe(false);
  release();
  await closing.done;
  expect(socket.send).toHaveBeenCalledTimes(sentAfterStartup + 1);
  expect(JSON.parse(socket.send.mock.lastCall![0]).items).toHaveLength(2);
  const issued = statements.length;
  await tick();
  expect(statements).toHaveLength(issued);
  inner.close();
});

test("outer collections and executions called from inside a $transaction reject instead of hanging", async () => {
  const sql = createNodeSqliteExecutor();
  const runtime = runtimeOver(immediateHost(), sql);
  await runtime.ready;
  const outcome = await runtime.collectionsApi.$transaction(async ($collections) => {
    await $collections.posts.update("welcome", { title: "inside" });
    return Promise.allSettled([
      runtime.collectionsApi.posts.get("welcome"),
      runtime.execute(execution(), (local) => local.execute({}, getWelcome)),
    ]);
  });
  expect(outcome).toEqual([
    { status: "rejected", reason: expect.objectContaining({ code: "SQL_REENTRANT_CALL" }) },
    // An execution reports failures as a result value.
    {
      status: "fulfilled",
      value: expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "SQL_REENTRANT_CALL" }),
      }),
    },
  ]);
  // The transaction itself committed, and independent calls keep working.
  await expect(runtime.collectionsApi.posts.get("welcome")).resolves.toMatchObject({
    title: "inside",
  });
  await runtime.close();
  sql.close();
});
