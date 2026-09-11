import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import { decodePublicHttp } from "../src/http";
import { decodeWireRequest, isWireResponse } from "../src/protocol";
import { normalizeValidationIssues } from "../src/result";
import { createDurableObjectStorage } from "../src/storage";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import type { StoredDocument } from "../src/types";

const context = { tenantId: "tenant-a" };

function listWire(limit: unknown) {
  return {
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { limit },
    context,
  };
}

function operationFailure(status: number) {
  return {
    ok: false,
    error: {
      kind: "operation",
      code: "FORBIDDEN",
      message: "Forbidden",
      status,
    },
  };
}

async function seedPosts(count: number) {
  const storage = createDurableObjectStorage(createSqliteDurableObjectStorage());
  const ts = "2026-08-26T00:00:00.000Z";
  for (let index = 0; index < count; index += 1) {
    await storage.put("posts", {
      id: `p${String(index).padStart(3, "0")}`,
      title: `post-${index}`,
      createdAt: ts,
      updatedAt: ts,
      rev: 1,
    } as StoredDocument);
  }
  return storage;
}

test("decodeWireRequest rejects a fractional list limit that JSON can carry", () => {
  expect(() => decodeWireRequest(listWire(1.5))).toThrow(BadRequestError);
  expect(() => decodeWireRequest(listWire(1.5))).toThrow(/Invalid list limit/);
});

test("decodeWireRequest rejects JSON Infinity written as 1e999", () => {
  const body = JSON.parse(
    `{"kind":"collection","collection":"posts","operation":"list","list":{"limit":1e999},"context":{"tenantId":"tenant-a"}}`,
  ) as unknown;
  expect(() => decodeWireRequest(body)).toThrow(BadRequestError);
  expect(() => decodeWireRequest(body)).toThrow(/Invalid list limit/);
});

test("decodeWireRequest rejects NaN as a list limit", () => {
  expect(() => decodeWireRequest(listWire(Number.NaN))).toThrow(BadRequestError);
  expect(() => decodeWireRequest(listWire(Number.NaN))).toThrow(/Invalid list limit/);
});

test("decodeWireRequest rejects zero, negative, and non-integer list limits", () => {
  for (const limit of [0, -1, Number.NEGATIVE_INFINITY, 1.1, 199.5]) {
    expect(() => decodeWireRequest(listWire(limit))).toThrow(BadRequestError);
    expect(() => decodeWireRequest(listWire(limit))).toThrow(/Invalid list limit/);
  }
});

test("decodeWireRequest rejects empty document ids the way action ids are rejected", () => {
  expect(() =>
    decodeWireRequest({
      kind: "collection",
      collection: "posts",
      operation: "get",
      id: "",
      context,
    }),
  ).toThrow(BadRequestError);
  expect(() =>
    decodeWireRequest({
      kind: "collection",
      collection: "posts",
      operation: "delete",
      id: "",
      context,
    }),
  ).toThrow(/Invalid CRUD id/);
});

test("isWireResponse rejects non-finite error status", () => {
  expect(isWireResponse(operationFailure(Number.NaN))).toBe(false);
  expect(isWireResponse(operationFailure(Number.POSITIVE_INFINITY))).toBe(false);
  expect(isWireResponse(operationFailure(JSON.parse("1e999") as number))).toBe(false);
});

test("isWireResponse rejects non-integer and out-of-range HTTP status", () => {
  for (const status of [0, 99, 200.5, 403.5, 600, 999]) {
    expect(isWireResponse(operationFailure(status))).toBe(false);
  }
});

test("decodePublicHttp rejects a digit string that overflows to Infinity", async () => {
  await expect(
    decodePublicHttp(new Request(`http://fire.test/posts?limit=${"9".repeat(400)}`)),
  ).rejects.toBeInstanceOf(BadRequestError);
});

test("list limit 1.5 must not disable pagination and return the whole collection", async () => {
  const storage = await seedPosts(8);
  await expect(storage.list("posts", { limit: 1.5 })).rejects.toBeInstanceOf(BadRequestError);
});

test("normalizeValidationIssues drops non-finite numeric path segments", () => {
  const issues = normalizeValidationIssues([
    { message: "bad", path: ["items", Number.NaN, Number.POSITIVE_INFINITY, 2] },
  ]);
  expect(issues).toEqual([{ message: "bad", path: ["items", 2] }]);
  expect(JSON.parse(JSON.stringify(issues))).toEqual([{ message: "bad", path: ["items", 2] }]);
});
