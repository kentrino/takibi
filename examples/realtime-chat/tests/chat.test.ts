import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import { expect, test } from "vite-plus/test";
import { handleRequest } from "../src/fetch.ts";
import { chatHandler } from "../src/handler.ts";
import type { ChatEnv, ChatHandler } from "../src/handler.ts";
import {
  DISPLAY_NAME_MAX_LENGTH,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_WATCH_LIMIT,
  chronologicalSnapshot,
  connectionPresentation,
  normalizeMessageBody,
  roomFromApiPath,
  routeWorkerPath,
  shouldClearComposer,
  type Room,
} from "../src/shared.ts";
import packageJson from "../package.json" with { type: "json" };

function handlerFor(room: Room) {
  return withSqliteTestBackend(chatHandler, {
    resolve: () => ({ room }),
  });
}

function clientFor(handler: ReturnType<typeof handlerFor>, room: Room) {
  return createClient<ChatHandler>(`https://chat.test/api/${room}`, {
    fetch: async (input, init) => {
      const result = await handler.handle(new Request(input, init), {
        prefix: `/api/${room}`,
        context: { room, env: {} as never },
      });
      if (!result.matched) throw new Error("Test request was not matched");
      return result.response;
    },
  });
}

test("routes only a complete, preset room segment", () => {
  expect(roomFromApiPath("/api/lobby/messages")).toBe("lobby");
  expect(roomFromApiPath("/api/help")).toBe("help");
  expect(roomFromApiPath("/api/unknown/messages")).toBeUndefined();
  expect(roomFromApiPath("/api/lobbyish/messages")).toBeUndefined();
  expect(roomFromApiPath("/api/%E0%A4%A/messages")).toBeUndefined();
  expect(routeWorkerPath("/")).toBe("assets");
  expect(routeWorkerPath("/style.css")).toBe("assets");
  expect(routeWorkerPath("/api/random/messages")).toEqual({ room: "random" });
  expect(routeWorkerPath("/api/secret")).toBe("unknown-room");
});

test("rejects blank drafts and keeps a newer composer value", () => {
  expect(normalizeMessageBody("   ")).toBeUndefined();
  expect(normalizeMessageBody("")).toBeUndefined();
  expect(normalizeMessageBody("x".repeat(MESSAGE_BODY_MAX_LENGTH + 1))).toBeUndefined();
  expect(normalizeMessageBody("  hello  ")).toBe("hello");
  expect(shouldClearComposer("hello", "hello")).toBe(true);
  expect(shouldClearComposer("hello!", "hello")).toBe(false);
});

test("reverses the newest-first snapshot and labels connection states", () => {
  expect(chronologicalSnapshot(["newest", "older"])).toEqual(["older", "newest"]);
  expect(connectionPresentation("connecting")).toEqual({ label: "Connecting", kind: "pending" });
  expect(connectionPresentation("open")).toEqual({ label: "Live", kind: "open" });
  expect(connectionPresentation("reconnecting")).toEqual({
    label: "Reconnecting",
    kind: "pending",
  });
  expect(connectionPresentation("disconnected")).toEqual({
    label: "Disconnected",
    kind: "terminal",
  });
});

test("validates messages and lists the latest messages by createdAt", async () => {
  using handler = handlerFor("lobby");
  const client = clientFor(handler, "lobby");

  const blankName = await client.messages.add({ displayName: "   ", body: "hello" });
  const blankBody = await client.messages.add({ displayName: "Aさん", body: "   " });
  const longName = await client.messages.add({
    displayName: "n".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    body: "hello",
  });
  const longBody = await client.messages.add({
    displayName: "Aさん",
    body: "x".repeat(MESSAGE_BODY_MAX_LENGTH + 1),
  });
  expect(blankName.ok).toBe(false);
  expect(blankBody.ok).toBe(false);
  expect(longName.ok).toBe(false);
  expect(longBody.ok).toBe(false);

  const markup = await client.messages.add({
    displayName: "Aさん",
    body: "<em>hello</em>",
  });
  const first = await client.messages.add({ displayName: "Aさん", body: "first" });
  const second = await client.messages.add({ displayName: "Bさん", body: "second" });
  expect(markup.ok).toBe(true);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (markup.ok) expect(markup.data.body).toBe("<em>hello</em>");

  const listed = await client.messages.list({
    index: "byCreatedAt",
    orderBy: (query) => query.createdAt.desc(),
    limit: 1,
  });
  expect(listed.ok).toBe(true);
  if (listed.ok) expect(listed.data.items.map((message) => message.body)).toEqual(["second"]);

  const window = await client.messages.list({
    index: "byCreatedAt",
    orderBy: (query) => query.createdAt.desc(),
    limit: MESSAGE_WATCH_LIMIT,
  });
  expect(window.ok).toBe(true);
  if (window.ok) {
    expect(window.data.items).toHaveLength(3);
    expect(chronologicalSnapshot(window.data.items).map((message) => message.body)).toEqual([
      "<em>hello</em>",
      "first",
      "second",
    ]);
  }
});

test("keeps rooms on isolated stores", async () => {
  using lobby = handlerFor("lobby");
  using help = handlerFor("help");
  const lobbyClient = clientFor(lobby, "lobby");
  const helpClient = clientFor(help, "help");

  const added = await lobbyClient.messages.add({ displayName: "Aさん", body: "lobby only" });
  expect(added.ok).toBe(true);

  const helpList = await helpClient.messages.list({
    index: "byCreatedAt",
    orderBy: (query) => query.createdAt.desc(),
    limit: MESSAGE_WATCH_LIMIT,
  });
  expect(helpList.ok).toBe(true);
  if (helpList.ok) expect(helpList.data.items).toEqual([]);

  const lobbyList = await lobbyClient.messages.list({
    index: "byCreatedAt",
    orderBy: (query) => query.createdAt.desc(),
    limit: MESSAGE_WATCH_LIMIT,
  });
  expect(lobbyList.ok).toBe(true);
  if (lobbyList.ok)
    expect(lobbyList.data.items.map((message) => message.body)).toEqual(["lobby only"]);
});

test("worker serves assets, rejects unknown rooms, and prefixes known rooms", async () => {
  using lobby = handlerFor("lobby");
  const assets: string[] = [];
  const env = {
    ASSETS: {
      fetch: async (request: Request) => {
        assets.push(new URL(request.url).pathname);
        return new Response("ok");
      },
    },
    CHAT_ROOMS: {} as DurableObjectNamespace,
  } as ChatEnv;

  const home = await handleRequest(new Request("https://chat.test/"), env, lobby);
  expect(home.status).toBe(200);
  expect(assets).toEqual(["/"]);

  const unknown = await handleRequest(
    new Request("https://chat.test/api/secret/messages"),
    env,
    lobby,
  );
  expect(unknown.status).toBe(404);
  await expect(unknown.json()).resolves.toEqual({ error: "Unknown chat room" });

  const missing = await handleRequest(new Request("https://chat.test/api/lobby/anything"), env, {
    handle: async () => ({ matched: false as const }),
  });
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toEqual({ error: "Unknown API route" });

  const created = await handleRequest(
    new Request("https://chat.test/api/lobby/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Aさん", body: "from worker" }),
    }),
    env,
    lobby,
  );
  expect(created.status).toBe(200);
  const payload = (await created.json()) as { ok: boolean; data?: { body: string } };
  expect(payload).toMatchObject({ ok: true, data: { body: "from worker" } });
});

test("the example only depends on published Takibi entry points", () => {
  expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual(["takibi", "zod"]);
  expect(JSON.stringify(packageJson.devDependencies ?? {})).not.toMatch(/@takibi\//);
});
