import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import {
  ActionRegistry,
  defineCollection,
  MaintenanceLockedError,
  type CollectionsDef,
} from "@takibi/api";
import { fullAccess } from "@takibi/policy";
import type { SqlExecutor, SqlStatementExecutor } from "@takibi/storage";
import { createNodeSqliteExecutor } from "@takibi/testing/sqlite-storage";
import { createTenantRuntime, type TenantHost } from "../src/tenant-runtime";
import type { WatchHost, WatchSocket } from "../src/watch-runtime";

// The runtime runs here on node:sqlite with plain in-memory hosts: no Durable
// Object state, storage double, or Cloudflare globals.

const collections = {
  posts: defineCollection({
    schema: z.object({ title: z.string(), score: z.number() }),
    accessPolicy: fullAccess,
    indexes: { byScore: ["score"] },
    seed: async () => ({ welcome: { title: "hello", score: 1 } }),
  }),
};

function recordingSql(): { sql: SqlExecutor; statements: string[]; close: () => void } {
  const inner = createNodeSqliteExecutor();
  const statements: string[] = [];
  const record = (executor: SqlStatementExecutor): SqlStatementExecutor => ({
    exec(query, ...bindings) {
      statements.push(query.replace(/\s+/g, " ").trim());
      return executor.exec(query, ...bindings);
    },
  });
  const sql: SqlExecutor = {
    ...record(inner),
    transaction: (callback) => inner.transaction((scoped) => callback(record(scoped))),
  };
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
    // `CollectionsDef` erases schemas, so typed index keys need an explicit widening.
    collections: collections as unknown as CollectionsDef,
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
  const sql: SqlExecutor = {
    exec: async () => {
      throw failure;
    },
    transaction: async () => {
      throw failure;
    },
  };
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
