import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Root `vp test` must load each package config so `~/` aliases
    // resolve against that package's tsconfig, not the workspace root.
    projects: ["packages/*"],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["**/worker-configuration.d.ts", ".legacy/**"],
  },
  lint: {
    ignorePatterns: ["**/worker-configuration.d.ts", "docs/**", ".legacy/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
