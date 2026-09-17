import { expect, test } from "vite-plus/test";
import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import { chatHandler } from "../src/handler.ts";
import { roomFromApiPath } from "../src/shared.ts";

test("routes only a complete, preset room segment", () => {
  expect(roomFromApiPath("/api/lobby/messages")).toBe("lobby");
  expect(roomFromApiPath("/api/help")).toBe("help");
  expect(roomFromApiPath("/api/unknown/messages")).toBeUndefined();
  expect(roomFromApiPath("/api/lobbyish/messages")).toBeUndefined();
  expect(roomFromApiPath("/api/%E0%A4%A/messages")).toBeUndefined();
});

test("validates messages and lists the latest messages by createdAt", async () => {
  using handler = withSqliteTestBackend(chatHandler, {
    resolve: () => ({ room: "lobby" }),
  });
  const client = createClient<typeof chatHandler>("https://chat.test", {
    fetch: async (input, init) => {
      const result = await handler.handle(new Request(input, init), {
        context: { room: "lobby", env: {} as never },
      });
      if (!result.matched) throw new Error("Test request was not matched");
      return result.response;
    },
  });

  const invalid = await client.messages.add({ displayName: "   ", body: "hello" });
  expect(invalid.ok).toBe(false);

  const first = await client.messages.add({ displayName: "Aさん", body: "first" });
  const second = await client.messages.add({ displayName: "Bさん", body: "second" });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);

  const listed = await client.messages.list({
    index: "byCreatedAt",
    orderBy: (query) => query.createdAt.desc(),
    limit: 1,
  });
  expect(listed.ok).toBe(true);
  if (listed.ok) expect(listed.data.items.map((message) => message.body)).toEqual(["second"]);
});
