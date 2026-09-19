export const ROOMS = ["lobby", "help", "random"] as const;
export type Room = (typeof ROOMS)[number];

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
