import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const PUBLISHED_WORKSPACE_DEPS = [
  { dir: "packages/takibi", filter: "takibi" },
  { dir: "packages/hono-adapter", filter: "@takibi/hono-adapter" },
] as const;

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function ensureDist(dir: string, filter: string): void {
  if (existsSync(join(repoRoot, dir, "dist/index.d.mts"))) return;
  run("pnpm", ["--filter", filter, "run", "build"], repoRoot);
}

for (const pkg of PUBLISHED_WORKSPACE_DEPS) ensureDist(pkg.dir, pkg.filter);
run("vp", ["pack", ...process.argv.slice(2)], packageRoot);
