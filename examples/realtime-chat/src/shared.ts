import type { WatchState } from "takibi/watch";

export const ROOMS = ["lobby", "help", "random"] as const;
export type Room = (typeof ROOMS)[number];

export const DISPLAY_NAME_MAX_LENGTH = 40;
export const MESSAGE_BODY_MAX_LENGTH = 500;
export const MESSAGE_WATCH_LIMIT = 50;

export type ConnectionKind = "pending" | "open" | "terminal";

export const ROOM_LABELS = {
  lobby: "Lobby",
  help: "Help desk",
  random: "Random",
} as const satisfies Record<Room, string>;

export function isRoom(value: string): value is Room {
  return (ROOMS as readonly string[]).includes(value);
}

export function normalizeMessageBody(value: string): string | undefined {
  const body = value.trim();
  if (body.length < 1 || body.length > MESSAGE_BODY_MAX_LENGTH) return undefined;
  return body;
}

export function shouldClearComposer(currentValue: string, submittedValue: string): boolean {
  return currentValue === submittedValue;
}

export function connectionPresentation(state: WatchState | "disconnected"): {
  label: string;
  kind: ConnectionKind;
} {
  if (state === "open") return { label: "Live", kind: "open" };
  if (state === "disconnected") return { label: "Disconnected", kind: "terminal" };
  if (state === "reconnecting") return { label: "Reconnecting", kind: "pending" };
  return { label: "Connecting", kind: "pending" };
}

export function chronologicalSnapshot<T>(items: readonly T[]): T[] {
  return items.slice().reverse();
}
