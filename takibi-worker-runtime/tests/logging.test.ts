import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { withSqliteTestBackend } from "@takibi/takibi/testing";
import { fullAccess } from "@takibi/takibi-policy";
import { createPrettyConsoleLogger, createTakibi } from "../src";
import type { LogEvent, Logger } from "../src";

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

test("custom logger receives filtered stage events without request data", async () => {
  const events: LogEvent[] = [];
  const handler = createSqliteTestHandler(events);
  const response = await handler.request("https://takibi.test/posts/p1", {
    method: "POST",
    headers: {
      authorization: "Bearer private-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "private document body" }),
  });

  expect(response.status).toBe(200);
  const actionResponse = await handler.request("https://takibi.test/$:ping", {
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
  const missing = await handler.request("https://takibi.test/posts/missing");

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
    throwing.request("https://takibi.test/posts/p1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "still succeeds" }),
    }),
  ).resolves.toMatchObject({ status: 200 });
});

test("failure logging emits one error before the request completion", async () => {
  const events: LogEvent[] = [];
  const handler = createSqliteTestHandler(events, "info");

  const response = await handler.request("https://takibi.test/posts/missing");
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

test("pretty console logger is the owner binding", () => {
  expect(typeof createPrettyConsoleLogger).toBe("function");
  const logger = createPrettyConsoleLogger();
  expect(typeof logger.log).toBe("function");
});
