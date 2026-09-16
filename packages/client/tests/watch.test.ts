import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWatchClient } from "../src/watch";
import { createClient } from "../src/client";
import type { TakibiDefinitionCarrier } from "@takibi/api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { WATCH_PROTOCOL } from "@takibi/protocol";

type Handler = TakibiDefinitionCarrier & {
  "~takibi": {
    collections: {
      posts: { schema: StandardSchemaV1<{ title: string }, { title: string }> };
    };
    actions: {};
  };
};
class Socket {
  static instances: Socket[] = [];
  protocol = WATCH_PROTOCOL;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    Socket.instances.push(this);
  }
  message(items: unknown[] = []) {
    this.onmessage?.({ data: JSON.stringify({ version: 1, kind: "snapshot", items }) });
  }
}
const nativeWebSocket = globalThis.WebSocket;
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const current = () => Socket.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("opt-in watch lifecycle", () => {
  it("returns synchronously, delivers asynchronously, deduplicates, and suppresses captured late events", async () => {
    const next = vi.fn();
    const state = vi.fn();
    const watch = createWatchClient<Handler>("https://example.com/api").posts.watch(
      {},
      { next, state },
    );
    expect(state).not.toHaveBeenCalled();
    vi.runAllTicks();
    await tick();
    current().onopen?.();
    current().message([{ title: "a" }]);
    current().message([{ title: "a" }]);
    expect(next).toHaveBeenCalledTimes(1);
    const late = current().onmessage!;
    watch.unsubscribe();
    watch.unsubscribe();
    late({ data: "invalid" });
    expect(await watch.closed).toEqual({ reason: "unsubscribed" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries opaque handshakes with fresh protocols, leaving closed pending", async () => {
    const protocols = vi.fn().mockResolvedValueOnce(["first"]).mockResolvedValue(["second"]);
    const state = vi.fn();
    const watch = createWatchClient<Handler>("https://example.com", {
      webSocketProtocols: protocols,
      headers: { authorization: "never-copy" },
    }).posts.watch({}, { next() {}, state });
    const closed = vi.fn();
    void watch.closed.then(closed);
    vi.runAllTicks();
    await tick();
    const lateClose = current().onclose!;
    current().onerror?.();
    lateClose({ code: 1006 });
    await tick();
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(Socket.instances).toHaveLength(2);
    expect(current().protocols).toEqual([WATCH_PROTOCOL, "second"]);
    expect(current().url).not.toContain("never-copy");
    expect(state).toHaveBeenCalledWith("reconnecting");
    watch.unsubscribe();
  });
  it("cancels during asynchronous credential refresh", async () => {
    let resolve!: (value: string[]) => void;
    const watch = createWatchClient<Handler>("https://example.com", {
      webSocketProtocols: () =>
        new Promise((r) => {
          resolve = r;
        }),
    }).posts.watch({}, { next() {} });
    vi.runAllTicks();
    await tick();
    watch.unsubscribe();
    resolve(["late"]);
    await tick();
    expect(Socket.instances).toHaveLength(0);
    expect(await watch.closed).toEqual({ reason: "unsubscribed" });
  });
  it.each(["server-closed", "protocol-error", "server-error"] as const)(
    "settles %s once without retry",
    async (reason) => {
      const watch = createWatchClient<Handler>("https://example.com").posts.watch(
        {},
        { next() {} },
      );
      vi.runAllTicks();
      await tick();
      if (reason === "server-closed") current().onclose?.({ code: 1000 });
      else if (reason === "protocol-error") current().onmessage?.({ data: new ArrayBuffer(2) });
      else
        current().onmessage?.({
          data: JSON.stringify({
            version: 1,
            kind: "error",
            reason: "server-error",
            error: { kind: "operation", code: "DENIED", status: 403, message: "no" },
          }),
        });
      expect((await watch.closed).reason).toBe(reason);
      watch.unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("reports callback errors through the host without closing or disrupting watches", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const next = vi.fn(() => {
      throw new Error("application");
    });
    const watch = createWatchClient<Handler>("https://example.com").posts.watch({}, { next });
    vi.runAllTicks();
    await tick();
    current().message();
    current().message([{ title: "a" }]);
    expect(next).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
    watch.unsubscribe();
    expect((await watch.closed).reason).toBe("unsubscribed");
  });
  it("allows unsubscribe inside state and next without scheduling more work", async () => {
    const watch = createWatchClient<Handler>("https://example.com").posts.watch(
      {},
      {
        next() {},
        state() {
          watch.unsubscribe();
        },
      },
    );
    vi.runAllTicks();
    await tick();
    expect(Socket.instances).toHaveLength(0);
    expect(await watch.closed).toEqual({ reason: "unsubscribed" });
  });
  it("rejects cursor at runtime and leaves HTTP-only creation independent of WebSocket", () => {
    vi.stubGlobal("WebSocket", undefined);
    expect(() => createClient<Handler>("https://example.com")).not.toThrow();
    expect(() =>
      createWatchClient<Handler>("https://example.com").posts.watch(
        // @ts-expect-error watch has no cursor
        { cursor: "x" },
        { next() {} },
      ),
    ).toThrow("cursor");
  });
  it("uses browser-compatible subprotocol tokens and rejects native invalid token lists", () => {
    expect(
      () => new nativeWebSocket("ws://example.invalid", [WATCH_PROTOCOL, "has space"]),
    ).toThrow();
    expect(
      () => new nativeWebSocket("ws://example.invalid", [WATCH_PROTOCOL, WATCH_PROTOCOL]),
    ).toThrow();
  });
  it("retains compiled ordering and suppresses an unchanged reconnect snapshot", async () => {
    const next = vi.fn();
    const client = createWatchClient<Handler>("https://example.com");
    const watch = client.posts.watch({ where: (q) => q.title.eq("a"), limit: 1 }, { next });
    vi.runAllTicks();
    await tick();
    const url = current().url;
    current().message([{ title: "a" }]);
    current().onclose?.({ code: 1013 });
    await vi.advanceTimersByTimeAsync(250);
    expect(current().url).toBe(url);
    current().message([{ title: "a" }]);
    expect(next).toHaveBeenCalledTimes(1);
    current().message([{ title: "b" }]);
    expect(next).toHaveBeenCalledTimes(2);
    watch.unsubscribe();
  });
  it("treats a valid terminal protocol envelope and missing selected protocol as terminal", async () => {
    const watch = createWatchClient<Handler>("https://example.com").posts.watch({}, { next() {} });
    vi.runAllTicks();
    await tick();
    current().onmessage?.({
      data: JSON.stringify({
        version: 1,
        kind: "error",
        reason: "protocol-error",
        error: { kind: "operation", code: "BAD_REQUEST", message: "obsolete", status: 400 },
      }),
    });
    expect((await watch.closed).reason).toBe("protocol-error");
    const second = createWatchClient<Handler>("https://example.com").posts.watch({}, { next() {} });
    vi.runAllTicks();
    await tick();
    current().protocol = "";
    current().onopen?.();
    expect((await second.closed).reason).toBe("protocol-error");
    expect(vi.getTimerCount()).toBe(0);
  });
});
