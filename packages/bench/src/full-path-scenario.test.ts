import { expect, test } from "vite-plus/test";
import { runFullPathScenario } from "@takibi/issue-tracker";

test("bench measures the shared issue-tracker scenario", () => {
  expect(typeof runFullPathScenario).toBe("function");
});
