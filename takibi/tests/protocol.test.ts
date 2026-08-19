import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import { decodeWireRequest } from "../src/protocol";

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
