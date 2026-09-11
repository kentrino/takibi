import { expectTypeOf, test } from "vite-plus/test";
import * as Api from "@takibi/api";

test("root entry exposes the collection and action definition contract", () => {
  expectTypeOf(Api.defineCollection).toBeFunction();
  expectTypeOf(Api.createDocumentActionBuilder).toBeFunction();
  expectTypeOf(Api.ActionRegistry).toBeConstructibleWith();
  expectTypeOf(Api.TakibiError).toBeConstructibleWith("CODE", "message");
  expectTypeOf<Api.TakibiDefinition>().toHaveProperty("~takibi");
});

test("root entry does not expose higher-layer factories", () => {
  expectTypeOf(Api).not.toHaveProperty("createTakibi");
  expectTypeOf(Api).not.toHaveProperty("createClient");
});
