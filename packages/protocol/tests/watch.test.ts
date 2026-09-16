import { describe, expect, it } from "vite-plus/test";
import { decodeWatchAttachment, normalizeWatchList, parseWatchEnvelope } from "../src/watch";
import { decodeCollectionReadRequest } from "../src/wire";
const list = {
  limit: 3,
  index: "byRoomScore",
  orderBy: { field: "score", direction: "desc" },
  where: { field: "room", op: "eq", value: "r" },
};
describe("watch protocol", () => {
  it("round-trips the same normalized wire list and attachment options", () => {
    // The list parser supplies the canonical query representation.
    const options = list;
    const normal = decodeCollectionReadRequest({
      kind: "collection",
      collection: "posts",
      operation: "list",
      list: options,
    }).list;
    expect(normalizeWatchList(options)).toEqual(normal);
    expect(
      decodeWatchAttachment(
        JSON.parse(JSON.stringify({ version: 1, collection: "posts", list: options, context: {} })),
      ).list,
    ).toEqual(normal);
  });
  it.each([
    { cursor: "x" },
    { index: "" },
    { orderBy: { field: "x", direction: "asc" } },
    { unknown: true },
  ])("rejects invalid list options %j", (options) => {
    expect(() => normalizeWatchList(options)).toThrow();
  });
  it.each([
    "{}",
    "null",
    "invalid",
    JSON.stringify({ version: 0, kind: "snapshot", items: [] }),
    JSON.stringify({ version: 1, kind: "snapshot", items: [], cursor: "x" }),
    JSON.stringify({ version: 1, kind: "snapshot", items: [null] }),
    JSON.stringify({
      version: 1,
      kind: "error",
      reason: "server-error",
      error: { kind: "operation", code: "X", message: "x", status: 400, extra: true },
    }),
  ])("fails closed for malformed and obsolete server frames %s", (source) => {
    expect(() => parseWatchEnvelope(source)).toThrow();
  });
});
