import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const testingSrc = fileURLToPath(new URL("../testing/src/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@takibi/testing/sqlite-storage": `${testingSrc}sqlite-storage.server.ts`,
      "@takibi/testing": `${testingSrc}index.ts`,
    },
  },
  pack: {
    entry: {
      index: "src/index.ts",
      instrumentation: "src/instrumentation.ts",
      "testing-bridge": "src/testing-bridge.server.ts",
    },
    dts: {
      generator: "tsgo",
      // Declarations build from `src` only, without the test-time source
      // aliases for `@takibi/testing`, so tsgo never emits declarations
      // beside the testing sources. See tsconfig.pack.json.
      tsconfig: "tsconfig.pack.json",
    },
    exports: {
      devExports: true,
      customExports(exports) {
        for (const [key, value] of Object.entries(exports)) {
          if (typeof value === "string" && value.endsWith(".mjs")) {
            exports[key] = {
              types: value.replace(/\.mjs$/, ".d.mts"),
              import: value,
            };
          }
        }
        return exports;
      },
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
