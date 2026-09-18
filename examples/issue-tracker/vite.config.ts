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
        "*": "tests/*.test.ts",
      },
      dts: false,
      clean: false,
      deps: {
        alwaysBundle: [/^@takibi\//, /^takibi(?:\/|$)/, /^hono(?:\/|$)/, "zod"],
        onlyBundle: false,
      },
      exports: false,
    },
  ],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
