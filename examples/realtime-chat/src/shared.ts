export const ROOMS = ["lobby", "help", "random"] as const;
export type Room = (typeof ROOMS)[number];

export const DISPLAY_NAME_MAX_LENGTH = 40;
export const MESSAGE_BODY_MAX_LENGTH = 500;
export const MESSAGE_WATCH_LIMIT = 50;

export type WatchConnectionState = "connecting" | "open" | "reconnecting";
export type ConnectionKind = "pending" | "open" | "terminal";

export function isRoom(value: string): value is Room {
  return (ROOMS as readonly string[]).includes(value);
}

export function roomFromApiPath(pathname: string): Room | undefined {
  const match = /^\/api\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match) return undefined;
  let room: string;
  try {
    room = decodeURIComponent(match[1] ?? "");
  } catch {
    return undefined;
  }
  return isRoom(room) ? room : undefined;
}

export function routeWorkerPath(pathname: string): "assets" | "unknown-room" | { room: Room } {
  if (!pathname.startsWith("/api/")) return "assets";
  const room = roomFromApiPath(pathname);
  return room ? { room } : "unknown-room";
}

export function normalizeMessageBody(value: string): string | undefined {
  const body = value.trim();
  if (body.length < 1 || body.length > MESSAGE_BODY_MAX_LENGTH) return undefined;
  return body;
}

export function shouldClearComposer(currentValue: string, submittedValue: string): boolean {
  return currentValue === submittedValue;
}

export function connectionPresentation(
  state: WatchConnectionState | "disconnected",
): { label: string; kind: ConnectionKind } {
  if (state === "open") return { label: "Live", kind: "open" };
  if (state === "disconnected") return { label: "Disconnected", kind: "terminal" };
  if (state === "reconnecting") return { label: "Reconnecting", kind: "pending" };
  return { label: "Connecting", kind: "pending" };
}

export function chronologicalSnapshot<T>(items: readonly T[]): T[] {
  return items.slice().reverse();
}
