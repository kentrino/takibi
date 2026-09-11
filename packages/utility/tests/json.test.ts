import { expect, test } from "vite-plus/test";
import { assertJsonObject, assertJsonValue, JSON_MAX_DEPTH } from "@takibi/utility";

const options = {
  subject: "Value",
  error: (message: string) => new TypeError(message),
};

test("accepts JSON values and plain JSON objects", () => {
  expect(() => assertJsonValue([null, true, 42, "text", { nested: [] }], options)).not.toThrow();
  expect(() => assertJsonObject({ nested: { values: [1, 2, 3] } }, options)).not.toThrow();
  expect(() =>
    assertJsonObject(Object.assign(Object.create(null), { value: 1 }), options),
  ).not.toThrow();
});

test("rejects non-JSON primitives, prototypes, and object properties", () => {
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "value" });
  const symbolProperty = { value: 1 };
  Object.defineProperty(symbolProperty, Symbol("hidden"), { enumerable: true, value: 2 });

  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(), accessor]) {
    expect(() => assertJsonValue(value, options)).toThrow();
  }
  expect(() => assertJsonValue(symbolProperty, options)).toThrow(/symbol properties/);
  expect(() => assertJsonObject([], options)).toThrow(/plain JSON object/);
});

test("rejects cyclic, sparse, accessor, and custom-property arrays", () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const sparse: unknown[] = [];
  sparse.length = 2;
  sparse[0] = "first";
  const accessor = ["first"];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => "first" });
  const custom = ["first"];
  Object.defineProperty(custom, "extra", { enumerable: true, value: "second" });

  expect(() => assertJsonValue(cyclic, options)).toThrow(/cyclic/);
  expect(() => assertJsonValue(sparse, options)).toThrow(/data elements/);
  expect(() => assertJsonValue(accessor, options)).toThrow(/data elements/);
  expect(() => assertJsonValue(custom, options)).toThrow(/custom properties/);
});

test("enforces the nesting cap", () => {
  let value: unknown = null;
  for (let depth = 0; depth <= JSON_MAX_DEPTH; depth += 1) value = [value];

  expect(() => assertJsonValue(value, options)).toThrow(/maximum nesting depth/);
});
