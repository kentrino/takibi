import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import {
  decodeWireRequest,
  isBatchWireResponse,
  isWireResponse,
  MAX_BATCH_ITEMS,
} from "../src/protocol";

const context = { clinic: { slug: "clinic-a" }, actor: { id: "u1" } };

test("decodeWireRequest does not resolve collection or action names", () => {
  expect(
    decodeWireRequest({
      kind: "collection",
      collection: "ghosts",
      operation: "get",
      id: "g1",
      context,
    }),
  ).toMatchObject({ collection: "ghosts", operation: "get", id: "g1" });
  expect(
    decodeWireRequest({
      kind: "action",
      scope: "ghosts",
      name: "haunt",
      context,
    }),
  ).toMatchObject({ scope: "ghosts", name: "haunt" });
});

test("decodeWireRequest accepts exact CRUD and action requests", () => {
  expect(
    decodeWireRequest({
      kind: "collection",
      collection: "posts",
      operation: "get",
      id: "p1",
      context,
    }),
  ).toEqual({
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "p1",
    context,
  });
  expect(
    decodeWireRequest({
      kind: "action",
      scope: "posts",
      name: "publish",
      input: null,
      context,
    }),
  ).toEqual({
    kind: "action",
    scope: "posts",
    name: "publish",
    input: null,
    context,
  });
});

test("decodeWireRequest rejects invalid envelopes as BadRequestError", () => {
  const rejects = (body: unknown, message: RegExp) => {
    expect(() => decodeWireRequest(body)).toThrow(BadRequestError);
    expect(() => decodeWireRequest(body)).toThrow(message);
  };

  for (const body of [null, [], "get", 1]) {
    rejects(body, /Invalid wire request/);
  }
  rejects({ kind: "rpc", context }, /Invalid wire request kind/);
  rejects(
    { kind: "collection", collection: "posts", operation: "patch", id: "p1", context },
    /Invalid CRUD operation/,
  );
  rejects(
    { kind: "collection", collection: "posts", operation: "get", context },
    /Invalid CRUD id/,
  );
  rejects(
    { kind: "collection", collection: "posts", operation: "get", id: 1, context },
    /Invalid CRUD id/,
  );
  rejects(
    { kind: "collection", collection: "posts", operation: "add", context },
    /Invalid CRUD wire request/,
  );
  rejects(
    {
      kind: "action",
      scope: "$",
      name: "exportAll",
      collection: "posts",
      context,
    },
    /Unexpected wire field/,
  );
  rejects(
    {
      kind: "collection",
      collection: "posts",
      operation: "get",
      id: "p1",
      name: "publish",
      context,
    },
    /Unexpected wire field/,
  );
  rejects(
    {
      kind: "collection",
      collection: "posts",
      operation: "list",
      list: { limit: "10" },
      context,
    },
    /Invalid list limit/,
  );
});

test("decodeWireRequest accepts application-owned context keys and requires an object", () => {
  expect(
    decodeWireRequest({
      kind: "action",
      scope: "$",
      name: "exportAll",
      context: { arbitrary: true },
    }),
  ).toMatchObject({ context: { arbitrary: true } });
  for (const invalid of [null, [], "clinic-a"]) {
    expect(() =>
      decodeWireRequest({
        kind: "action",
        scope: "$",
        name: "exportAll",
        context: invalid,
      }),
    ).toThrow(BadRequestError);
    expect(() =>
      decodeWireRequest({
        kind: "action",
        scope: "$",
        name: "exportAll",
        context: invalid,
      }),
    ).toThrow(/Invalid wire context/);
  }
});

test("decodeWireRequest normalizes list queries and rejects malformed AST", () => {
  const request = {
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: {
      limit: 10,
      where: { field: "ownerId", op: "eq", value: "u1" },
    },
    context,
  };
  expect(decodeWireRequest(request)).toEqual(request);

  expect(() =>
    decodeWireRequest({
      ...request,
      list: {
        where: { field: "ownerId", op: "eq", value: ["u1"] },
      },
    }),
  ).toThrow(BadRequestError);
  expect(() =>
    decodeWireRequest({
      ...request,
      list: {
        where: { field: "ownerId", op: "eq", value: "u1", extra: true },
      },
    }),
  ).toThrow(BadRequestError);
});

test("isWireResponse accepts valid policy reasons and rejects malformed reasons", () => {
  const valid = {
    ok: false,
    error: {
      kind: "operation",
      code: "FORBIDDEN",
      message: "Forbidden",
      status: 403,
      reason: {
        code: "LOCKED_ITEM",
        description: "Locked items cannot be changed.",
      },
    },
  };
  expect(isWireResponse(valid)).toBe(true);
  expect(
    isWireResponse({
      ...valid,
      error: {
        ...valid.error,
        reason: { code: "LOCKED_ITEM" },
      },
    }),
  ).toBe(true);

  for (const reason of [
    null,
    "LOCKED_ITEM",
    {},
    { code: 42 },
    { code: "LOCKED_ITEM", description: 42 },
    { code: "LOCKED_ITEM", private: true },
  ]) {
    expect(
      isWireResponse({
        ...valid,
        error: { ...valid.error, reason },
      }),
    ).toBe(false);
  }
  expect(
    isWireResponse({
      ...valid,
      error: { ...valid.error, code: "NOT_FOUND" },
    }),
  ).toBe(false);
  expect(
    isWireResponse({
      ...valid,
      error: {
        kind: "validation",
        code: "VALIDATION",
        message: "Invalid",
        status: 400,
        issues: [],
        reason: { code: "LOCKED_ITEM" },
      },
    }),
  ).toBe(false);
});

test("decodeWireRequest accepts a shared-context read batch and rejects writes", () => {
  expect(MAX_BATCH_ITEMS).toBe(20);
  expect(
    decodeWireRequest({
      kind: "batch",
      items: [
        { kind: "collection", collection: "posts", operation: "get", id: "p1" },
        { kind: "collection", collection: "posts", operation: "list" },
      ],
      context,
    }),
  ).toEqual({
    kind: "batch",
    items: [
      { kind: "collection", collection: "posts", operation: "get", id: "p1" },
      { kind: "collection", collection: "posts", operation: "list" },
    ],
    context,
  });

  expect(() =>
    decodeWireRequest({
      kind: "batch",
      items: [{ kind: "collection", collection: "posts", operation: "delete", id: "p1" }],
      context,
    }),
  ).toThrow(BadRequestError);
  expect(() =>
    decodeWireRequest({
      kind: "batch",
      items: [{ kind: "action", scope: "$", name: "exportAll" }],
      context,
    }),
  ).toThrow(BadRequestError);
  expect(() =>
    decodeWireRequest({
      kind: "batch",
      items: [],
      context,
    }),
  ).toThrow(BadRequestError);
});

test("isBatchWireResponse requires the same number of item envelopes", () => {
  const items = [
    { ok: true as const, data: { id: "p1" } },
    {
      ok: false as const,
      error: {
        kind: "operation" as const,
        code: "NOT_FOUND",
        message: "Not found",
        status: 404,
      },
    },
  ];
  expect(isBatchWireResponse({ ok: true, data: items }, 2)).toBe(true);
  expect(isBatchWireResponse({ ok: true, data: items }, 1)).toBe(false);
  expect(isBatchWireResponse({ ok: true, data: [{ id: "p1" }] }, 1)).toBe(false);
  expect(
    isBatchWireResponse(
      {
        ok: false,
        error: { kind: "operation", code: "BAD_REQUEST", message: "bad", status: 400 },
      },
      2,
    ),
  ).toBe(false);
});
