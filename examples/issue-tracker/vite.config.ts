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
      dts: {
        tsgo: true,
        tsconfig: "tsconfig.pack.json",
      },
      deps: {
        neverBundle: [/^takibi(?:\/|$)/, /^@takibi\//, /^hono(?:\/|$)/, "zod"],
        onlyImport: [/^takibi(?:\/|$)/, /^@takibi\//, /^hono(?:\/|$)/, "zod"],
        onlyBundle: false,
        dts: {
          neverBundle: [/^takibi(?:\/|$)/, /^@takibi\//, /^hono(?:\/|$)/, "zod"],
        },
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
