import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      "full-path-scenario.test": "tests/full-path-scenario.test.ts",
    },
    dts: false,
    deps: {
      alwaysBundle: [/^@takibi\//, /^takibi(?:\/|$)/, /^hono(?:\/|$)/, "zod"],
      onlyBundle: false,
    },
    exports: {
      devExports: true,
      customExports(exports) {
        delete exports["./full-path-scenario.test"];
        return exports;
      },
    },
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "tests/full-path-scenario.test.ts"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
