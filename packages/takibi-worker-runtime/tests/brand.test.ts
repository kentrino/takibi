import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  TAKIBI_BRAND,
  assignTakibiBrand,
  readTakibiBrand,
  type TakibiBrandCarrier,
} from "../src/brand";

test("assign writes a hidden brand that read returns", () => {
  const collections = { posts: { seed: "posts" } };
  const actions = { $: { ping: true } };
  const handler = assignTakibiBrand({ handle: true }, { collections, actions });

  expect(Object.keys(handler)).toEqual(["handle"]);
  expect(Object.getOwnPropertyDescriptor(handler, TAKIBI_BRAND)).toMatchObject({
    enumerable: false,
    writable: false,
    configurable: false,
  });
  expect(readTakibiBrand(handler)).toEqual({
    context: null,
    initial: null,
    services: null,
    collections,
    actions,
  });
  expectTypeOf(handler).toExtend<TakibiBrandCarrier>();
  expectTypeOf(readTakibiBrand(handler).collections).toEqualTypeOf<typeof collections>();
  expectTypeOf(readTakibiBrand(handler).actions).toEqualTypeOf<typeof actions>();
});

test("read exposes null for phantom runtime fields", () => {
  const handler = assignTakibiBrand<
    { handle: true },
    Record<string, never>,
    Record<string, never>,
    { tenantId: string },
    { authToken: string },
    { format(value: string): string }
  >({ handle: true }, { collections: {}, actions: {} });

  const brand = readTakibiBrand(handler);

  expectTypeOf(brand.context).toEqualTypeOf<null>();
  expectTypeOf(brand.initial).toEqualTypeOf<null>();
  expectTypeOf(brand.services).toEqualTypeOf<null>();
  expect(brand).toMatchObject({ context: null, initial: null, services: null });
});
