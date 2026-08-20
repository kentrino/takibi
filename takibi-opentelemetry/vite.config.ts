import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      logs: "src/logs.ts",
    },
    dts: {
      tsgo: true,
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
