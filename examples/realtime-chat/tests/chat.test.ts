import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import { expect, test } from "vite-plus/test";
import { createChatApp } from "../src/app.tsx";
import { chatHandler } from "../src/handler.ts";
import type { ChatEnv, ChatHandler } from "../src/handler.ts";
import {
  DISPLAY_NAME_MAX_LENGTH,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_WATCH_LIMIT,
  chronologicalSnapshot,
  connectionPresentation,
  isRoom,
  normalizeMessageBody,
  shouldClearComposer,
  type Room,
} from "../src/shared.ts";
import packageJson from "../package.json" with { type: "json" };

// SQLite bypasses stub, but handle still requires the production input type.
// Fail loudly if a test accidentally starts using either runtime binding.
const sqliteEnv: ChatEnv = {
  get CHAT_ROOMS(): DurableObjectNamespace {
    throw new Error("SQLite tests must not resolve a Durable Object");
  },
  get ASSETS(): Fetcher {
    throw new Error("SQLite tests must not fetch assets");
  },
};

function handlerFor() {
  return withSqliteTestBackend(chatHandler);
}

function clientFor(handler: ReturnType<typeof handlerFor>, room: Room) {
  return createClient<ChatHandler>(`https://chat.test/api/${room}`, {
    fetch: async (input, init) => {
      const result = await handler.handle(new Request(input, init), {
        prefix: `/api/${room}`,
        context: { room, env: sqliteEnv },
      });
      if (!result.matched) throw new Error("Test request was not matched");
      return result.response;
    },
  });
}

test("accepts only the preset rooms", () => {
  expect(isRoom("lobby")).toBe(true);
  expect(isRoom("help")).toBe(true);
  expect(isRoom("random")).toBe(true);
  expect(isRoom("unknown")).toBe(false);
  expect(isRoom("lobbyish")).toBe(false);
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
  using handler = handlerFor();
  const client = clientFor(handler, "lobby");

  const blankName = await client.messages.add({ displayName: "   ", body: "hello" });
  const blankBody = await client.messages.add({ displayName: "Alice", body: "   " });
  const longName = await client.messages.add({
    displayName: "n".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
    body: "hello",
  });
  const longBody = await client.messages.add({
    displayName: "Alice",
    body: "x".repeat(MESSAGE_BODY_MAX_LENGTH + 1),
  });
  expect(blankName.ok).toBe(false);
  expect(blankBody.ok).toBe(false);
  expect(longName.ok).toBe(false);
  expect(longBody.ok).toBe(false);

  const markup = await client.messages.add({
    displayName: "Alice",
    body: "<em>hello</em>",
  });
  const first = await client.messages.add({ displayName: "Alice", body: "first" });
  const second = await client.messages.add({ displayName: "Bob", body: "second" });
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

test("keeps two independently created SQLite stores isolated", async () => {
  using lobby = handlerFor();
  using help = handlerFor();
  const lobbyClient = clientFor(lobby, "lobby");
  const helpClient = clientFor(help, "help");

  const added = await lobbyClient.messages.add({ displayName: "Alice", body: "lobby only" });
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

test("hono serves the page, assets, unknown rooms, and known room prefixes", async () => {
  using lobby = handlerFor();
  const app = createChatApp(lobby);
  const assets: string[] = [];
  const env = {
    ASSETS: {
      connect() {
        throw new Error("Asset tests must not open TCP sockets");
      },
      fetch: async (request: Request) => {
        assets.push(new URL(request.url).pathname);
        return new Response("ok");
      },
    },
    get CHAT_ROOMS(): DurableObjectNamespace {
      return sqliteEnv.CHAT_ROOMS;
    },
  } satisfies ChatEnv;

  const home = await app.fetch(new Request("https://chat.test/"), env);
  expect(home.status).toBe(200);
  expect(home.headers.get("content-type")).toMatch(/text\/html/);
  const html = await home.text();
  expect(html).toContain("Takibi Fireside");
  expect(html).toContain('id="chat-grid"');
  expect(html).toContain('id="room"');
  expect(assets).toEqual([]);

  const css = await app.fetch(new Request("https://chat.test/main.css"), env);
  expect(css.status).toBe(200);
  expect(assets).toEqual(["/main.css"]);

  const unknown = await app.fetch(new Request("https://chat.test/api/secret/messages"), env);
  expect(unknown.status).toBe(404);
  await expect(unknown.json()).resolves.toEqual({ error: "Unknown chat room" });

  const missing = await app.fetch(new Request("https://chat.test/api/lobby/anything"), env);
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toMatchObject({ ok: false });

  const created = await app.fetch(
    new Request("https://chat.test/api/lobby/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Alice", body: "from worker" }),
    }),
    env,
  );
  expect(created.status).toBe(200);
  const payload = (await created.json()) as { ok: boolean; data?: { body: string } };
  expect(payload).toMatchObject({ ok: true, data: { body: "from worker" } });
});

test("the example only depends on published Takibi entry points", () => {
  expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
    "@takibi/hono-adapter",
    "hono",
    "takibi",
    "zod",
  ]);
  expect(JSON.stringify(packageJson.devDependencies ?? {})).not.toMatch(/@takibi\//);
});

// This exercises the production stub resolver, independently of SQLite storage.
test("production handler selects the named Durable Object for each room", async () => {
  const names: string[] = [];
  const selected: DurableObjectId[] = [];
  const forwarded: { room: Room; context: unknown }[] = [];
  const ids = new Map<DurableObjectId, Room>();
  const namespace = {
    idFromName(name: string) {
      names.push(name);
      const id = { toString: () => name } as DurableObjectId;
      ids.set(id, name as Room);
      return id;
    },
    get(id: DurableObjectId) {
      selected.push(id);
      const room = ids.get(id);
      if (!room) throw new Error("Expected the id returned by idFromName");
      return {
        async fetch(request: Request) {
          const wire = (await request.json()) as { context: unknown };
          forwarded.push({ room, context: wire.context });
          return Response.json({ ok: true, data: { items: [], nextCursor: null } });
        },
      };
    },
  };
  const env: ChatEnv = {
    // Only the namespace methods used by this example are implemented.
    CHAT_ROOMS: namespace as unknown as DurableObjectNamespace,
    get ASSETS(): Fetcher {
      throw new Error("API requests must not fetch assets");
    },
  };
  for (const room of ["lobby", "help", "lobby"] as const) {
    const response = await createChatApp().fetch(
      new Request(`https://chat.test/api/${room}/messages`),
      env,
    );
    expect(response.status).toBe(200);
  }
  expect(names).toEqual(["lobby", "help", "lobby"]);
  expect(selected.map((id) => id.toString())).toEqual(names);
  expect(forwarded).toEqual(names.map((room) => ({ room, context: { room } })));
});
