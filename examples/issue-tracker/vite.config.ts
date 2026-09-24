import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const publishedExternals = [
  /^takibi(?:\/|$)/,
  /^@takibi\/hono-adapter(?:\/|$)/,
  /^hono(?:\/|$)/,
  "zod",
];

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  pack:
    process.env.ISSUE_TRACKER_PACK === "tests"
      ? {
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
        }
      : {
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
            onlyBundle: false,
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
