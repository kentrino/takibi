import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  pack: [
    {
      entry: {
        index: "src/index.ts",
      },
      dts: false,
      exports: {
        devExports: true,
        customExports(exports) {
          return exports;
        },
      },
    },
    {
      entry: {
        "run-packed-tests": "src/run-packed-tests.ts",
      },
      dts: false,
      clean: false,
      deps: {
        neverBundle: [/^vite-plus(?:\/|$)/, /^vitest(?:\/|$)/],
      },
      exports: false,
    },
    {
      entry: {
        "*": "tests/*.test.ts",
      },
      dts: false,
      clean: false,
      deps: {
        alwaysBundle: [/^@takibi\//, /^takibi(?:\/|$)/, /^hono(?:\/|$)/, "zod"],
        neverBundle: [/^vite-plus(?:\/|$)/, /^vitest(?:\/|$)/],
        onlyBundle: false,
      },
      exports: false,
    },
  ],
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
