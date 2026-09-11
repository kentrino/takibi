import { expect, expectTypeOf, test } from "vite-plus/test";
import type { ObserverInvocationData } from "@takibi/shared-types";
import { debugInvocationFields, invocationFields } from "../src/context/runtime";
import type { PublicRequest } from "../src/http";
import type { TakibiWireInvocation } from "../src/invocation-type-map";

test("log field helpers accept observer, wire, and public request shapes", () => {
  expectTypeOf<ObserverInvocationData>().toExtend<Parameters<typeof invocationFields>[0]>();
  expectTypeOf<TakibiWireInvocation>().toExtend<Parameters<typeof invocationFields>[0]>();
  expectTypeOf<PublicRequest>().toExtend<Parameters<typeof invocationFields>[0]>();
  expectTypeOf<ObserverInvocationData>().toExtend<Parameters<typeof debugInvocationFields>[0]>();
  expectTypeOf<TakibiWireInvocation>().toExtend<Parameters<typeof debugInvocationFields>[0]>();
  expectTypeOf<PublicRequest>().toExtend<Parameters<typeof debugInvocationFields>[0]>();
});

test("log field helpers read shared identity fields without treating values as full requests", () => {
  const observer: ObserverInvocationData = {
    kind: "action",
    scope: "posts",
    name: "publish",
    id: "p1",
  };
  const wire: TakibiWireInvocation = {
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { where: { op: "eq", field: "title", value: "secret" } },
  };
  const batch: PublicRequest = { kind: "batch", items: [] };

  expect(invocationFields(observer)).toEqual({
    collection: "posts",
    operation: "publish",
    documentId: "p1",
  });
  expect(debugInvocationFields(wire)).toEqual({
    collection: "posts",
    operation: "list",
    query: { op: "eq", field: "title", value: "secret" },
  });
  expect(invocationFields(batch)).toEqual({ batchSize: 0 });
});
