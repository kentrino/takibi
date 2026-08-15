import { expect, test } from "vite-plus/test";
import { BadRequestError } from "../src/errors";
import { decodeWireRequest } from "../src/protocol";

const context = { tenantId: "tenant-a", user: { id: "u1" } };

test("decodeWireRequest accepts exact CRUD and action requests", () => {
  expect(
    decodeWireRequest({
      kind: "crud",
      collection: "posts",
      operation: "get",
      id: "p1",
      context,
    }),
  ).toEqual({
    kind: "crud",
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

test("decodeWireRequest enforces CRUD/action XOR and exact routing fields", () => {
  expect(() =>
    decodeWireRequest({
      kind: "action",
      scope: "$",
      name: "exportAll",
      collection: "posts",
      context,
    }),
  ).toThrow(/Unexpected wire field/);
  expect(() =>
    decodeWireRequest({
      kind: "crud",
      collection: "posts",
      operation: "get",
      id: "p1",
      name: "publish",
      context,
    }),
  ).toThrow(/Unexpected wire field/);
  expect(() =>
    decodeWireRequest({
      kind: "crud",
      collection: "posts",
      operation: "get",
      context,
    }),
  ).toThrow(/Invalid CRUD id/);
});

test("decodeWireRequest requires trusted context shape", () => {
  expect(() =>
    decodeWireRequest({
      kind: "action",
      scope: "$",
      name: "exportAll",
      context: { tenantId: "tenant-a" },
    }),
  ).toThrow(/Invalid wire context/);
});

test("decodeWireRequest normalizes list queries and rejects malformed AST", () => {
  const request = {
    kind: "crud",
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
