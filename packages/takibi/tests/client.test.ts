/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, expectTypeOf, test } from "vite-plus/test";
import * as ClientPkg from "@takibi/client";
import * as ClientFacade from "takibi/client";
import { AlreadyExistsError, TakibiError } from "takibi";

test("direct client package and Takibi client facade share constructors", () => {
  expect(ClientFacade.createClient).toBe(ClientPkg.createClient);
  expect(ClientFacade.TakibiError).toBe(ClientPkg.TakibiError);
  expect(ClientFacade.AlreadyExistsError).toBe(ClientPkg.AlreadyExistsError);
  expect(ClientFacade.StaleWriteError).toBe(ClientPkg.StaleWriteError);
  expect(ClientFacade.ListAllLimitError).toBe(ClientPkg.ListAllLimitError);
  expect(ClientFacade.AlreadyExistsError).toBe(AlreadyExistsError);
  expect(new ClientFacade.AlreadyExistsError()).toBeInstanceOf(TakibiError);
  expect(new ClientPkg.AlreadyExistsError()).toBeInstanceOf(TakibiError);
  expectTypeOf<
    ClientFacade.ClientOf<{ readonly "~takibi": { collections: { posts: unknown } } }>
  >().toHaveProperty("posts");
});

test("built client facade recognizes constructors from the client package specifier", async () => {
  const clientDist = join(import.meta.dirname, "../dist/client.mjs");
  if (!existsSync(clientDist)) return;
  const js = readFileSync(clientDist, "utf8");
  if (!js.includes("@takibi/client")) return;

  const Built = await import(pathToFileURL(clientDist).href);
  expect(js).toMatch(/@takibi\/client/);
  expect(Built.createClient).toBe(ClientPkg.createClient);
  expect(Built.TakibiError).toBe(ClientPkg.TakibiError);
  expect(new Built.AlreadyExistsError()).toBeInstanceOf(ClientPkg.AlreadyExistsError);
});
