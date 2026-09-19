/**
 * Remove an already matched Hono basePath from a raw URL pathname.
 * Hono may decode Unicode in base, but preserves encoded slashes. Counting
 * segments therefore locates the boundary without decoding or re-encoding path.
 * Matching belongs to Hono; this function does not check whether base owns path.
 */
export function stripPath({ base, path }: { base: string; path: string }): string {
  const baseSegments = base === "/" ? 0 : base.split("/").length - 1;
  return (
    "/" +
    path
      .split("/")
      .slice(baseSegments + 1)
      .join("/")
  );
}
