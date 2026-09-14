import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Root `vp test` must load each package config so `~/` aliases
    // resolve against that package's tsconfig, not the workspace root.
    projects: ["packages/*", "examples/*"],
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      "**/CHANGELOG.md",
      "**/worker-configuration.d.ts",
      ".legacy/**",
      "e2e/consumer-template/**",
      "e2e/.consumer/**",
    ],
  },
  lint: {
    ignorePatterns: ["**/worker-configuration.d.ts", "docs/**", ".legacy/**", "e2e/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
