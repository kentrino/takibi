import { expect, expectTypeOf, test } from "vite-plus/test";
import * as Client from "../src";

test("client package exports createClient, inference types, and API errors", () => {
  expectTypeOf(Client.createClient).toBeFunction();
  expectTypeOf(Client.TakibiError).toBeConstructibleWith("CODE", "message");
  expectTypeOf(Client.UnauthorizedError).toBeConstructibleWith();
  expectTypeOf(Client.ForbiddenError).toBeConstructibleWith();
  expectTypeOf(Client.NotFoundError).toBeConstructibleWith();
  expectTypeOf(Client.BadRequestError).toBeConstructibleWith("bad");
  expectTypeOf(Client.AlreadyExistsError).toBeConstructibleWith();
  expectTypeOf(Client.StaleWriteError).toBeConstructibleWith();
  expectTypeOf(Client.ListAllLimitError).toBeConstructibleWith(1);
  expectTypeOf<
    Client.ClientOf<{ readonly "~takibi": { collections: { posts: unknown } } }>
  >().toHaveProperty("posts");
  expectTypeOf<Client.CreateClientOptions>().toHaveProperty("headers");
  expectTypeOf<Client.CreateClientOptions>().toHaveProperty("fetch");
  expectTypeOf<Client.CreateClientOptions>().toHaveProperty("batch");
  expectTypeOf<Client.CreateClientOptions>().toHaveProperty("listAll");
  expectTypeOf(Client).not.toHaveProperty("createTakibi");
  expectTypeOf(Client).not.toHaveProperty("and");
  expectTypeOf(Client).not.toHaveProperty("or");
  expectTypeOf(Client).not.toHaveProperty("grant");
  expectTypeOf(Client).not.toHaveProperty("queryImpliesEquality");
  expectTypeOf(Client).not.toHaveProperty("defineCollection");
  expect(new Client.AlreadyExistsError()).toBeInstanceOf(Client.TakibiError);
});
