import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Api from "../src";

test("api package exports builders, registry, errors, and inference types", () => {
  expectTypeOf(Api.defineCollection).toBeFunction();
  expectTypeOf(Api.createDocumentActionBuilder).toBeFunction();
  expectTypeOf(Api.createRootActionBuilder).toBeFunction();
  expectTypeOf(Api.assertCollectionName).toBeFunction();
  expectTypeOf(Api.assertNoActionsOption).toBeFunction();
  expectTypeOf(Api.ActionRegistry).toBeConstructibleWith();
  expectTypeOf(Api.TakibiError).toBeConstructibleWith("CODE", "message");
  expectTypeOf(Api.UnauthorizedError).toBeConstructibleWith();
  expectTypeOf(Api.ForbiddenError).toBeConstructibleWith();
  expectTypeOf(Api.NotFoundError).toBeConstructibleWith();
  expectTypeOf(Api.BadRequestError).toBeConstructibleWith("bad");
  expectTypeOf(Api.AlreadyExistsError).toBeConstructibleWith();
  expectTypeOf(Api.StaleWriteError).toBeConstructibleWith();
  expectTypeOf(Api.ListAllLimitError).toBeConstructibleWith(1);
  expectTypeOf(Api.bindResultListAll).toBeFunction();
  expectTypeOf(Api.bindThrowingListAll).toBeFunction();
  expectTypeOf<Api.TakibiDefinition>().toHaveProperty("~takibi");
  expectTypeOf<Api.TakibiDefinitionCarrier>().toHaveProperty("~takibi");
  // @ts-expect-error ClientOf is owned by @takibi/takibi-client
  type _ClientOf = Api.ClientOf;
  // @ts-expect-error InferHandlerCollections is owned by @takibi/takibi-client
  type _InferHandlerCollections = Api.InferHandlerCollections;
  // @ts-expect-error InferHandlerActions is owned by @takibi/takibi-client
  type _InferHandlerActions = Api.InferHandlerActions;
  expectTypeOf(Api).not.toHaveProperty("createTakibi");
  expectTypeOf(Api).not.toHaveProperty("createClient");
  expectTypeOf(Api).not.toHaveProperty("queryImpliesEquality");
  expectTypeOf(Api).not.toHaveProperty("allows");
  expect(Api.unsafeClientPropertyNames.has("then")).toBe(true);
});
