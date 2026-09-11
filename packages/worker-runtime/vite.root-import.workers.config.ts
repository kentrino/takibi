import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.root-import.test.jsonc" },
    }),
  ],
  test: {
    include: ["tests/root-import.workers.ts"],
  },
});
