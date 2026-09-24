import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const PUBLISHED_WORKSPACE_DEPS = [
  { dir: "packages/takibi", filter: "takibi" },
  { dir: "packages/hono-adapter", filter: "@takibi/hono-adapter" },
] as const;

type Manifest = {
  exports: unknown;
  publishConfig?: { exports?: unknown };
};

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function ensureDist(dir: string, filter: string): void {
  if (existsSync(join(repoRoot, dir, "dist/index.d.mts"))) return;
  run("pnpm", ["--filter", filter, "run", "build"], repoRoot);
}

function publishExports(dir: string): { path: string; original: string } {
  const path = join(repoRoot, dir, "package.json");
  const original = readFileSync(path, "utf8");
  const manifest = JSON.parse(original) as Manifest;
  const exports = manifest.publishConfig?.exports;
  if (exports === undefined) throw new Error(`${dir} is missing publishConfig.exports`);
  writeFileSync(path, `${JSON.stringify({ ...manifest, exports }, null, 2)}\n`);
  return { path, original };
}

for (const pkg of PUBLISHED_WORKSPACE_DEPS) ensureDist(pkg.dir, pkg.filter);
const snapshots = PUBLISHED_WORKSPACE_DEPS.map((pkg) => publishExports(pkg.dir));

try {
  run("vp", ["pack", ...process.argv.slice(2)], packageRoot);
} finally {
  for (const { path, original } of snapshots) writeFileSync(path, original);
}
