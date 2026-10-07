import { defineConfig } from "vite-plus";

const publishedExternals = [
  /^takibi(?:\/|$)/,
  /^@takibi\/hono-adapter(?:\/|$)/,
  /^hono(?:\/|$)/,
  "zod",
];

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
    },
    dts: {
      tsgo: true,
      tsconfig: "tsconfig.pack.json",
    },
    deps: {
      neverBundle: publishedExternals,
      onlyImport: publishedExternals,
      onlyBundle: [],
      dts: {
        neverBundle: publishedExternals,
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
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
