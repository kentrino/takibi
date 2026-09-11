import { expect, test } from "vite-plus/test";
import {
  decodeWireRequest,
  encodeWireRequest,
  isWireResponse,
  parseWireRequest,
  TakibiProtocolError,
  type WireRequest,
} from "@takibi/protocol";

const request = {
  kind: "collection",
  collection: "appointments",
  operation: "list",
  list: {
    where: { field: "clinicId", op: "eq", value: "clinic-a" },
  },
  context: { clinicId: "clinic-a" },
} satisfies WireRequest;

test("roundtrips a wire request through its JSON codec", () => {
  expect(parseWireRequest(encodeWireRequest(request))).toEqual(request);
});

test("normalizes decoded wire query ASTs", () => {
  const decoded = decodeWireRequest(request);
  expect(decoded.kind === "collection" && Object.isFrozen(decoded.list?.where)).toBe(true);
});

test("rejects invalid JSON and invalid wire operations", () => {
  expect(() => parseWireRequest("{")).toThrow(TakibiProtocolError);
  expect(() =>
    decodeWireRequest({
      kind: "collection",
      collection: "appointments",
      operation: "count",
      context: {},
    }),
  ).toThrow(/Invalid CRUD operation/);
});

test("validates response envelopes independently of the runtime", () => {
  expect(isWireResponse({ ok: true, data: null })).toBe(true);
  expect(
    isWireResponse({
      ok: false,
      error: { kind: "operation", code: "NOT_FOUND", message: "Not found", status: 404 },
    }),
  ).toBe(true);
  expect(isWireResponse({ ok: false, error: { code: "NOPE" } })).toBe(false);
});
