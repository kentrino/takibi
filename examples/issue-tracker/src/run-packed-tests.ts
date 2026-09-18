import { fileURLToPath } from "node:url";
import { startVitest } from "vite-plus/test/node";

const distDir = fileURLToPath(new URL(".", import.meta.url));
const vitest = await startVitest("test", [], {
  watch: false,
  config: false,
  root: distDir,
  dir: distDir,
  include: ["**/*.test.mjs"],
  exclude: ["**/node_modules/**"],
});
if (!vitest) process.exit(1);
await vitest.close();
process.exit(process.exitCode === undefined ? 0 : process.exitCode);
