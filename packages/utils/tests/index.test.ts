import { expect, test } from "vite-plus/test";
import { fn } from "@takibi/utils";

test("fn", () => {
  expect(fn()).toBe("Hello, takibi!");
});
