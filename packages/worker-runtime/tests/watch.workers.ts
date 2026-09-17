import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WATCH_PROTOCOL } from "@takibi/protocol";
import { setWatchEnv, watchHandler, WatchTestObject } from "./watch-fixture";

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});
function fixture() {
  setWatchEnv(env);
  const partition = crypto.randomUUID();
  const stub = env.TAKIBI_WATCH_TEST.get(env.TAKIBI_WATCH_TEST.idFromName(partition));
  const call = async (path: string, init: RequestInit = {}, context = {}) => {
    const result = await watchHandler.handle(new Request(`https://example.com/${path}`, init), {
      context: { partition, ...context },
    });
    if (!result.matched) throw new Error("unmatched");
    return result.response;
  };
  const connect = async (query = "", context = {}, headers = {}) => {
    const response = await call(
      `posts${query}`,
      { headers: { Upgrade: "websocket", "sec-websocket-protocol": WATCH_PROTOCOL, ...headers } },
      context,
    );
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe(WATCH_PROTOCOL);
    const socket = response.webSocket!;
    socket.accept();
    sockets.push(socket);
    const frames: any[] = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      frames.push(JSON.parse(String(event.data)));
    });
    await expect.poll(() => frames.length).toBe(1);
    return { socket, frames };
  };
  const add = (id: string, score: number, room = "r") =>
    call(`posts/${id}`, { method: "POST", body: JSON.stringify({ room, score, title: id }) });
  return { call, connect, add, stub };
}

describe("native Hibernation query watches", () => {
  it.each(["asc", "desc"])(
    "matches list for %s ordered limited windows after every commit",
    async (direction) => {
      const f = fixture();
      await f.add("a", 1);
      await f.add("b", 1);
      await f.add("c", 3);
      await f.add("foreign", 0, "other");
      const query = `?index=byRoomScore&orderBy=${encodeURIComponent(JSON.stringify({ field: "score", direction }))}&limit=2`;
      const { frames } = await f.connect(query);
      const equalList = async () => {
        const result: any = await (await f.call(`posts${query}`)).json();
        expect(frames.at(-1).items).toEqual(result.data.items);
      };
      await equalList();
      const mutate = async (path: string, init: RequestInit) => {
        const length = frames.length;
        expect((await f.call(path, init)).ok).toBe(true);
        await expect.poll(() => frames.length).toBeGreaterThan(length);
        await equalList();
      };
      await mutate("posts/d", {
        method: "POST",
        body: JSON.stringify({ room: "r", score: 2, title: "d" }),
      });
      await mutate("posts/c", { method: "PATCH", body: JSON.stringify({ score: 0 }) });
      await mutate("posts/b", { method: "DELETE" });
      await mutate("posts/a", {
        method: "PUT",
        body: JSON.stringify({ room: "r", score: 8, title: "new" }),
      });
    },
  );
  it("keeps other partitions and collections isolated; atomic actions publish only committed data", async () => {
    const f = fixture();
    const other = fixture();
    const { frames } = await f.connect();
    await other.add("elsewhere", 1);
    await f.call("other/x", { method: "POST", body: JSON.stringify({ title: "other" }) });
    const rollback = await f.call("posts:rollback", { method: "POST" });
    expect(rollback.status).toBe(500);
    await f.call("posts:addPair", { method: "POST" });
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1].items.map((item: any) => item.id)).toEqual(["first", "second"]);
  });
  it("recovers attachments with index options on a fresh generated instance", async () => {
    const f = fixture();
    const query = `?index=byRoomScore&orderBy=${encodeURIComponent(JSON.stringify({ field: "score", direction: "desc" }))}&limit=1`;
    const { frames } = await f.connect(query);
    await runInDurableObject<WatchTestObject, void>(f.stub, async (_instance, state) => {
      const recovered = new WatchTestObject(state, env);
      await recovered.$collections.posts.add(
        { room: "r", score: 4, title: "recovered" },
        { id: "recovered" },
      );
    });
    await expect.poll(() => frames.at(-1).items[0]?.id).toBe("recovered");
  });
  it("checks expired policy before the next snapshot, and terminates without documents", async () => {
    const f = fixture();
    const { frames, socket } = await f.connect("", { expires: Date.now() + 150 });
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 160));
    await f.add("private", 1);
    await expect.poll(() => frames.length).toBe(2);
    expect(frames[1].kind).toBe("error");
    expect(frames[1].error.reason.code).toBe("SESSION_EXPIRED");
    expect(frames[1].items).toBeUndefined();
    expect((await closed).code).toBe(4403);
  });
  it("rejects cursor, malformed protocols, denied policy, overflow and cross-origin cookies", async () => {
    const f = fixture();
    const upgrade = (query = "", headers = {}, context = {}) =>
      f.call(
        `posts${query}`,
        { headers: { Upgrade: "websocket", "sec-websocket-protocol": WATCH_PROTOCOL, ...headers } },
        context,
      );
    expect((await upgrade("?cursor=x")).status).toBe(400);
    expect((await upgrade("", { "sec-websocket-protocol": "invalid protocol" })).status).toBe(400);
    expect((await upgrade("", {}, { expires: 0 })).status).toBe(403);
    expect((await upgrade("", {}, { extra: "x".repeat(16_384) })).status).toBe(400);
    expect((await upgrade("", { cookie: "session=x", origin: "https://evil.test" })).status).toBe(
      403,
    );
    await f.connect(
      "",
      {},
      {
        cookie: "session=x",
        origin: "https://example.com",
        "sec-websocket-protocol": `${WATCH_PROTOCOL}, credential.token`,
      },
    );
  });
  it("closes application/binary messages terminally and reset reconnects to a full snapshot", async () => {
    const f = fixture();
    const { socket } = await f.connect();
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
    socket.send(new Uint8Array([1]));
    expect((await closed).code).toBe(4400);
    const second = await f.connect();
    const resetClosed = new Promise<CloseEvent>((resolve) =>
      second.socket.addEventListener("close", resolve),
    );
    await runInDurableObject<WatchTestObject, void>(f.stub, async (instance) => {
      await instance.$collections.$resetAll();
    });
    expect((await resetClosed).code).toBe(1013);
    expect((await f.connect()).frames[0].items).toEqual([]);
  });
  it("restores after cutover and blocks upgrades while an export lease is held", async () => {
    const f = fixture();
    await f.add("saved", 1);
    const watched = await f.connect();
    let snapshot = "";
    await runInDurableObject<WatchTestObject, void>(f.stub, async (instance) => {
      const stream = await instance.$collections.$exportSnapshot();
      const response = await f.call("posts", {
        headers: { Upgrade: "websocket", "sec-websocket-protocol": WATCH_PROTOCOL },
      });
      expect(response.status).toBe(503);
      snapshot = await new Response(stream).text();
    });
    await f.add("extra", 2);
    const closed = new Promise<CloseEvent>((resolve) =>
      watched.socket.addEventListener("close", resolve),
    );
    await runInDurableObject<WatchTestObject, void>(f.stub, async (instance) => {
      await instance.$collections.$restoreSnapshot(new Response(snapshot).body!);
    });
    expect((await closed).code).toBe(1013);
    expect((await f.connect()).frames[0].items.map((item: any) => item.id)).toEqual(["saved"]);
  });
  it("recovers an obsolete deployed attachment with a terminal protocol outcome", async () => {
    const f = fixture();
    const watched = await f.connect();
    const closed = new Promise<CloseEvent>((resolve) =>
      watched.socket.addEventListener("close", resolve),
    );
    await runInDurableObject<WatchTestObject, void>(f.stub, async (_instance, state) => {
      for (const socket of state.getWebSockets()) {
        const value = JSON.parse(socket.deserializeAttachment());
        socket.serializeAttachment(JSON.stringify({ ...value, version: 0 }));
      }
      const replacement = new WatchTestObject(state, env);
      await replacement.$collections.posts.list();
    });
    expect((await closed).code).toBe(4400);
    expect(watched.frames.at(-1).reason).toBe("protocol-error");
  });
  it("refreshes resolved scope on a new handshake and rejects invalid indexed queries", async () => {
    const f = fixture();
    await f.add("r", 1);
    await f.add("s", 2, "s");
    const first = await f.connect();
    first.socket.close();
    const second = await f.connect("", { room: "s" });
    expect(second.frames[0].items.map((item: any) => item.id)).toEqual(["s"]);
    for (const query of [
      "?index=missing",
      "?index=byScoreRoom&orderBy=" +
        encodeURIComponent(JSON.stringify({ field: "room", direction: "asc" })),
      "?orderBy=" + encodeURIComponent(JSON.stringify({ field: "score", direction: "asc" })),
      "?index=byRoomScore&orderBy=" +
        encodeURIComponent(JSON.stringify({ field: "title", direction: "asc" })),
    ]) {
      const response = await f.call(`posts${query}`, {
        headers: { Upgrade: "websocket", "sec-websocket-protocol": WATCH_PROTOCOL },
      });
      expect(response.status).toBe(400);
    }
    // JSON contexts above the old 2 KiB limit remain usable on the current platform.
    await f.connect("", { extra: "x".repeat(3000) });
  });
  it("publishes trusted transactions and policy-bound action writes without rollback leakage", async () => {
    const f = fixture();
    const watched = await f.connect();
    await runInDurableObject<WatchTestObject, void>(f.stub, async (instance) => {
      await expect(
        instance.$collections.$transaction(async (tx) => {
          await tx.posts.add({ room: "r", score: 1, title: "discard" }, { id: "discard" });
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      await instance.$collections.$transaction(async (tx) => {
        await tx.posts.add({ room: "r", score: 1, title: "kept" }, { id: "kept" });
        await tx.posts.update("kept", { score: 4 });
      });
    });
    await expect.poll(() => watched.frames.length).toBe(2);
    expect(watched.frames[1].items.map((item: any) => item.id)).toEqual(["kept"]);
    await f.call("posts:policyWrite", { method: "POST" });
    await expect.poll(() => watched.frames.at(-1).items[0].score).toBe(9);
  });
  it("fans out one committed collection change to sixteen active watches", async () => {
    const f = fixture();
    const active = await Promise.all(Array.from({ length: 16 }, () => f.connect("?limit=1")));
    const started = performance.now();
    await f.add("fanout", 1);
    await expect
      .poll(() => active.every(({ frames }) => frames.at(-1).items[0]?.id === "fanout"))
      .toBe(true);
    console.info(
      `watch fan-out sample: 16 watches, one matching document, ${(performance.now() - started).toFixed(1)} ms including test polling`,
    );
    for (const { frames } of active) expect(frames).toHaveLength(2);
  });
});
