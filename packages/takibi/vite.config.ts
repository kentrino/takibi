import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      client: "src/client-entry.ts",
      instrumentation: "src/instrumentation.ts",
      testing: "src/testing.server.ts",
    },
    dts: {
      generator: "tsgo",
      tsconfig: "../tsconfig.takibi-pack.json",
    },
    deps: {
      alwaysBundle: [/^@takibi\//],
      onlyBundle: ["@standard-schema/spec", "tatenuki", "@noble/hashes"],
      onlyImport: [],
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
