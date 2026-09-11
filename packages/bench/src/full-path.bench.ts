import { bench, describe } from "vite-plus/test";
import { runFullPathScenario } from "@takibi/issue-tracker";

describe("Takibi full path", () => {
  bench(
    "issue-tracker lifecycle",
    async () => {
      await runFullPathScenario();
    },
    {
      iterations: 10,
      time: 3_000,
      warmupIterations: 1,
      warmupTime: 500,
    },
  );
});
