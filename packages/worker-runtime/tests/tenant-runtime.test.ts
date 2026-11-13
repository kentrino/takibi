import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import {
  ActionRegistry,
  defineCollection,
  MaintenanceLockedError,
  type CollectionsDef,
} from "@takibi/api";
import { fullAccess } from "@takibi/policy";
import { SqlExecutor, type SqlStatementExecutor } from "@takibi/storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";
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

test("close reports a startup failure that no call reported, and only once", async () => {
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
