import { expect, test } from "vite-plus/test";
import { add } from "../src/index";

test("add sums two numbers", () => {
  expect(add(1, 2)).toBe(3);
});
