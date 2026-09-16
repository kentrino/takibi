import type { WatchClosed, WatchObserver, WatchSubscription } from "@takibi/api";
import {
  WATCH_PROTOCOL,
  WATCH_PROTOCOL_CLOSE,
  WATCH_ERROR_CLOSE,
  parseWatchEnvelope,
} from "@takibi/protocol";

/** One connection generation at a time; terminal state dominates all late events. */
export function subscribe(
  url: string,
  observer: WatchObserver<unknown>,
  protocols?: () => string[] | Promise<string[]>,
): WatchSubscription<string> {
  let stopped = false;
  let generation = 0;
  let attempt = 0;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let previous: string | undefined;
  let settle!: (outcome: WatchClosed<string>) => void;
  const closed = new Promise<WatchClosed<string>>((resolve) => {
    settle = resolve;
  });
  const report = (error: unknown) => {
    if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    else
      setTimeout(() => {
        throw error;
      }, 0);
  };
  const invoke = (callback: () => void) => {
    if (stopped) return;
    try {
      callback();
    } catch (error) {
      report(error);
    }
  };
  const closeSocket = () => {
    const current = socket;
    socket = undefined;
    if (!current) return;
    current.onopen = current.onmessage = current.onclose = current.onerror = null;
    try {
      current.close(1000);
    } catch {
      /* Already closed or connecting. */
    }
  };
  const finish = (outcome: WatchClosed<string>) => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearTimeout(retry);
    closeSocket();
    settle(outcome);
  };
  const reconnect = () => {
    if (stopped) return;
    generation += 1;
    closeSocket();
    invoke(() => observer.state?.("reconnecting"));
    if (stopped) return;
    const cap = Math.min(30_000, 250 * 2 ** Math.min(attempt++, 7));
    retry = setTimeout(
      () => {
        void connect();
      },
      cap * (0.5 + Math.random() * 0.5),
    );
  };
  const connect = async () => {
    if (stopped) return;
    const token = ++generation;
    invoke(() => observer.state?.("connecting"));
    if (stopped) return;
    try {
      const credentials = protocols ? await protocols() : [];
      if (stopped || generation !== token) return;
      const current = new WebSocket(url, [WATCH_PROTOCOL, ...credentials]);
      socket = current;
      const active = () => !stopped && generation === token && socket === current;
      current.onopen = () => {
        if (!active()) return;
        if (current.protocol !== WATCH_PROTOCOL) {
          finish({ reason: "protocol-error", error: new Error("Unsupported watch protocol") });
          return;
        }
        invoke(() => observer.state?.("open"));
      };
      current.onmessage = (event) => {
        if (!active()) return;
        let envelope;
        try {
          envelope = parseWatchEnvelope(event.data);
        } catch (error) {
          finish({
            reason: "protocol-error",
            error: error instanceof Error ? error : new Error("Invalid watch frame"),
          });
          return;
        }
        if (envelope.kind === "error") {
          finish(
            envelope.reason === "protocol-error"
              ? { reason: "protocol-error", error: new Error(envelope.error.message) }
              : { reason: "server-error", error: envelope.error },
          );
          return;
        }
        attempt = 0;
        const serialized = JSON.stringify(envelope.items);
        if (serialized === previous) return;
        previous = serialized;
        invoke(() => observer.next({ items: envelope.items }));
      };
      current.onclose = (event) => {
        if (!active()) return;
        if (event.code === 1000) finish({ reason: "server-closed" });
        else if (event.code === WATCH_PROTOCOL_CLOSE || event.code === WATCH_ERROR_CLOSE) {
          finish({
            reason: "protocol-error",
            error: new Error("Watch closed without a valid terminal envelope"),
          });
        } else reconnect();
      };
      // Browsers hide handshake status. Error remains retryable; close may arrive late.
      current.onerror = () => {
        if (active()) reconnect();
      };
    } catch {
      if (!stopped && generation === token) reconnect();
    }
  };
  queueMicrotask(() => {
    void connect();
  });
  return { unsubscribe: () => finish({ reason: "unsubscribed" }), closed };
}
