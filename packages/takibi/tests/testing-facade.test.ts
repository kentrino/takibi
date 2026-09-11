import { expect, test } from "vite-plus/test";
import * as TestingOwner from "@takibi/testing";
import * as TestingFacade from "../src/testing.server";

test("Takibi testing entry re-exports the owner package bindings", () => {
  expect(TestingFacade.withSqliteTestBackend).toBe(TestingOwner.withSqliteTestBackend);
});
