import { requestTakibi } from "./helpers/request";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "takibi/testing";
import {
  createPrettyConsoleLogger,
  createTakibi,
  fullAccess,
  type LogEvent,
  type Logger,
} from "takibi";
import type { WireRequest } from "../src/protocol";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";

const Post = z.object({ title: z.string() });

function capturingLogger(events: LogEvent[]): Logger {
  return {
    log(event) {
      events.push(event);
    },
  };
}

function createSqliteTestHandler(
  events: LogEvent[],
  logLevel: "debug" | "info" | "error" = "debug",
) {
  const base = createTakibi()({
    resolve: ({ request }) => ({
      tenantId: "tenant-a",
      credential: request.headers.get("authorization"),
    }),
    logger: capturingLogger(events),
    logLevel,
  }).defineCollections({
    posts: {
      schema: Post,
      accessPolicy: fullAccess,
    },
  });
  const ping = base
    .defineAction()
    .policy(fullAccess)
    .handler(() => ({ pong: true }));
  return withSqliteTestBackend(base.actions({ $: { ping } }));
}

function fakeState(storage: DurableObjectStorage): DurableObjectState {
  return {
    storage,
    id: {},
    getWebSockets: () => [],
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

test("custom logger receives filtered stage events without request data", async () => {
  const events: LogEvent[] = [];
  const handler = createSqliteTestHandler(events);
  const response = await requestTakibi(handler, "https://takibi.test/posts/p1", {
    method: "POST",
    headers: {
      authorization: "Bearer private-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "private document body" }),
  });

  expect(response.status).toBe(200);
  const actionResponse = await requestTakibi(handler, "https://takibi.test/$:ping", {
    method: "POST",
  });
  expect(actionResponse.status).toBe(200);
  expect(events.filter(({ event }) => event === "takibi.request")).toHaveLength(4);
  expect(events.map(({ event }) => event)).toEqual(
    expect.arrayContaining([
      "takibi.resolve",
      "takibi.executor",
      "takibi.policy",
      "takibi.schema",
      "takibi.storage",
      "takibi.action",
    ]),
  );
  expect(
    events
      .filter(({ event }) => event !== "takibi.request")
      .every(({ level }) => level === "debug"),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private-token");
  expect(JSON.stringify(events)).not.toContain("private document body");
  for (const event of events) {
    expect(event).not.toHaveProperty("traceId");
    expect(event).not.toHaveProperty("spanId");
  }
});

test("errors match the public failure and logger throws never change results", async () => {
  const events: LogEvent[] = [];
  const handler = createSqliteTestHandler(events, "error");
  const missing = await requestTakibi(handler, "https://takibi.test/posts/missing");

  expect(missing.status).toBe(404);
  const failure = (await missing.json()) as {
    ok: false;
    error: { code: string; message: string; status: number };
  };
  expect(events).toEqual([
    expect.objectContaining({
      event: "takibi.error",
      level: "error",
      message: failure.error.message,
      method: "GET",
      path: "/posts/missing",
      errorCode: failure.error.code,
      status: failure.error.status,
    }),
  ]);

  const throwingProduction = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    logger: {
      log() {
        throw new Error("logger failed");
      },
    },
    logLevel: "debug",
  })
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const throwing = withSqliteTestBackend(throwingProduction);
  await expect(
    requestTakibi(throwing, "https://takibi.test/posts/p1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "still succeeds" }),
    }),
  ).resolves.toMatchObject({ status: 200 });
});

test("failure logging emits one error before the request completion", async () => {
  const events: LogEvent[] = [];
  const handler = createSqliteTestHandler(events, "info");

  const response = await requestTakibi(handler, "https://takibi.test/posts/missing");
  const body = (await response.json()) as {
    ok: false;
    error: { code: string; status: number };
  };

  expect(response.status).toBe(404);
  expect(events).toEqual([
    expect.objectContaining({
      event: "takibi.request",
      message: "started",
      operation: "get",
    }),
    expect.objectContaining({
      event: "takibi.error",
      errorCode: body.error.code,
      status: body.error.status,
    }),
    expect.objectContaining({
      event: "takibi.request",
      message: "completed",
      operation: "get",
      status: 404,
    }),
  ]);
});

test("decode failures log the error message and request path", async () => {
  const events: LogEvent[] = [];
  const handler = createSqliteTestHandler(events, "error");
  const result = await handler.handle(
    new Request("https://takibi.test/posts", {
      method: "POST",
      body: new Uint8Array(),
    }),
    { context: {} },
  );

  expect(result.matched).toBe(true);
  expect(result.response?.status).toBe(400);
  const failure = (await result.response!.json()) as {
    ok: false;
    error: { code: string; message: string; status: number };
  };
  expect(failure.error.message).toBe("Expected JSON body");
  expect(events).toEqual([
    expect.objectContaining({
      event: "takibi.error",
      level: "error",
      message: "Expected JSON body",
      method: "POST",
      path: "/posts",
      errorCode: failure.error.code,
      status: 400,
    }),
  ]);
  expect(events[0]).not.toHaveProperty("collection");
  expect(events[0]).not.toHaveProperty("operation");
});

test("logger mutation cannot change an in-flight query", async () => {
  const production = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    logger: {
      log(event) {
        if (event.query && "value" in event.query) {
          (event.query as { value: string }).value = "u2";
        }
      },
    },
    logLevel: "debug",
  })
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string(), ownerId: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  for (const [id, ownerId] of [
    ["p1", "u1"],
    ["p2", "u2"],
  ] as const) {
    await requestTakibi(handler, `https://takibi.test/posts/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: id, ownerId }),
    });
  }

  const where = encodeURIComponent(JSON.stringify({ field: "ownerId", op: "eq", value: "u1" }));
  const response = await requestTakibi(handler, `https://takibi.test/posts?where=${where}`);
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    data: { items: [{ id: "p1", ownerId: "u1" }] },
  });
});

test("logging options inherit and override through the SQLite test backend", async () => {
  const baseEvents: LogEvent[] = [];
  const replacementEvents: LogEvent[] = [];
  const builder = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    logger: capturingLogger(baseEvents),
    logLevel: "debug",
  });
  const production = builder
    .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
    .actions({});
  const disabled = withSqliteTestBackend(production, { logger: false });
  await requestTakibi(disabled, "https://takibi.test/posts/missing");
  expect(baseEvents).toEqual([]);

  const narrowed = withSqliteTestBackend(production, { logLevel: "error" });
  await requestTakibi(narrowed, "https://takibi.test/posts/missing");
  expect(baseEvents).toEqual([expect.objectContaining({ event: "takibi.error" })]);

  baseEvents.length = 0;
  const inherited = withSqliteTestBackend(production);
  await requestTakibi(inherited, "https://takibi.test/posts/missing");
  expect(baseEvents.some(({ event }) => event === "takibi.resolve")).toBe(true);

  const replaced = withSqliteTestBackend(production, {
    logger: capturingLogger(replacementEvents),
    logLevel: "info",
  });
  await requestTakibi(replaced, "https://takibi.test/posts/missing");
  expect(replacementEvents.every(({ level }) => level !== "debug")).toBe(true);
  expect(replacementEvents.some(({ event }) => event === "takibi.request")).toBe(true);
});

test("built-in console modes keep structured and pretty output distinct", async () => {
  const original = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const calls: Array<{ method: keyof typeof original; value: unknown }> = [];
  console.debug = (value) => calls.push({ method: "debug", value });
  console.info = (value) => calls.push({ method: "info", value });
  console.warn = (value) => calls.push({ method: "warn", value });
  console.error = (value) => calls.push({ method: "error", value });
  try {
    const silentProduction = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
    })
      .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
      .actions({});
    const silent = withSqliteTestBackend(silentProduction);
    await requestTakibi(silent, "https://takibi.test/posts/missing");
    expect(calls).toEqual([]);

    const structuredProduction = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      logger: true,
    })
      .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
      .actions({});
    const structured = withSqliteTestBackend(structuredProduction);
    await requestTakibi(structured, "https://takibi.test/posts/missing");
    expect(calls.some(({ method, value }) => method === "info" && typeof value === "object")).toBe(
      true,
    );
    expect(calls.some(({ method }) => method === "debug")).toBe(false);

    calls.length = 0;
    const levelOnlyProduction = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      logLevel: "debug",
    })
      .defineCollections({ posts: { schema: Post, accessPolicy: fullAccess } })
      .actions({});
    const levelOnly = withSqliteTestBackend(levelOnlyProduction);
    await requestTakibi(levelOnly, "https://takibi.test/posts/missing");
    expect(calls.some(({ method, value }) => method === "debug" && typeof value === "object")).toBe(
      true,
    );

    calls.length = 0;
    const pretty = createPrettyConsoleLogger();
    pretty.log({
      level: "debug",
      event: "takibi.storage",
      message: "completed",
      collection: "posts",
      operation: "list",
      durationMs: 1.25,
      query: { field: "ownerId", op: "eq", value: "u1" },
    });
    expect(calls).toEqual([
      {
        method: "debug",
        value:
          '[debug] takibi.storage completed collection=posts operation=list durationMs=1.250 query={"field":"ownerId","op":"eq","value":"u1"}',
      },
    ]);
    expect(String(calls[0]?.value)).not.toContain("\u001B[");

    calls.length = 0;
    createPrettyConsoleLogger({ colors: true }).log({
      level: "warn",
      event: "takibi.request",
      message: "colored",
    });
    expect(calls[0]).toMatchObject({ method: "warn" });
    expect(String(calls[0]?.value)).toContain("\u001B[33mwarn\u001B[0m");
  } finally {
    console.debug = original.debug;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
});

test("Durable Object executor uses the same event vocabulary", async () => {
  const events: LogEvent[] = [];
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    logger: capturingLogger(events),
    logLevel: "debug",
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  const object = new handler.DurableObject(fakeState(createSqliteDurableObjectStorage()), {});
  const response = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        kind: "collection",
        collection: "posts",
        operation: "add",
        id: "p1",
        input: { title: "inside" },
        context: { tenantId: "tenant-a" },
      } satisfies WireRequest),
    }),
  );

  expect(response.status).toBe(200);
  expect(events.map(({ event }) => event)).toEqual(
    expect.arrayContaining(["takibi.executor", "takibi.policy", "takibi.schema", "takibi.storage"]),
  );
  expectTypeOf(createPrettyConsoleLogger).returns.toMatchTypeOf<Logger>();
});

test("Durable Object dispatch emits the wire stage without serializing its logger", async () => {
  const events: LogEvent[] = [];
  let wireBody: unknown;
  const handler = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
    stub: () =>
      ({
        async fetch(request: Request) {
          wireBody = await request.json();
          return Response.json({ ok: true, data: { id: "p1", title: "remote" } });
        },
      }) as DurableObjectStub,
    logger: capturingLogger(events),
    logLevel: "debug",
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});

  const response = await requestTakibi(handler, "https://takibi.test/posts/p1");
  expect(response.status).toBe(200);
  expect(events).toContainEqual(
    expect.objectContaining({
      event: "takibi.wire",
      collection: "posts",
      operation: "get",
      documentId: "p1",
    }),
  );
  expect(wireBody).toEqual({
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "p1",
    context: { tenantId: "tenant-a" },
  });
  expect(JSON.stringify(wireBody)).not.toContain("logger");
});
