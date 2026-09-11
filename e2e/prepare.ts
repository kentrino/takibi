import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const e2eRoot = join(repoRoot, "e2e");
export const tarballDir = join(e2eRoot, ".tarballs");
export const consumerDir = join(e2eRoot, ".consumer");

export const PUBLIC_PACKAGES = [
  { dir: "packages/takibi", name: "takibi" },
  { dir: "packages/hono-adapter", name: "@takibi/hono-adapter" },
  { dir: "packages/better-auth-adapter", name: "@takibi/better-auth-adapter" },
  { dir: "packages/opentelemetry", name: "@takibi/opentelemetry" },
] as const;

const CONSUMER_RUNTIME_PACKAGES = ["takibi", "@takibi/hono-adapter"] as const;

function run(command: string, args: string[], cwd = repoRoot): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function catalogVersion(name: string): string {
  const text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^[ \\t]+"?${escaped}"?:\\s+(\\S+)`, "m"));
  if (!match?.[1]) throw new Error(`catalog is missing ${name}`);
  return match[1];
}

export function tarballStem(name: string): string {
  return name.replace(/^@/, "").replace("/", "-");
}

export function findTarball(name: string): string {
  const stem = tarballStem(name);
  const match = readdirSync(tarballDir).find(
    (file) => file.startsWith(`${stem}-`) && file.endsWith(".tgz"),
  );
  if (!match) throw new Error(`missing tarball for ${name} in ${tarballDir}`);
  return join(tarballDir, match);
}

export function prepare(): void {
  rmSync(tarballDir, { recursive: true, force: true });
  rmSync(consumerDir, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  run("pnpm", [
    "--filter",
    "takibi",
    "--filter",
    "@takibi/hono-adapter",
    "--filter",
    "@takibi/better-auth-adapter",
    "--filter",
    "@takibi/opentelemetry",
    "run",
    "build",
  ]);

  for (const pkg of PUBLIC_PACKAGES) {
    run("pnpm", ["pack", "--pack-destination", tarballDir], join(repoRoot, pkg.dir));
  }

  const takibiManifest = JSON.parse(
    readFileSync(join(repoRoot, "packages/takibi/package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const workersTypes = takibiManifest.devDependencies?.["@cloudflare/workers-types"];
  if (!workersTypes) throw new Error("takibi is missing @cloudflare/workers-types");

  const tarballs = Object.fromEntries(
    CONSUMER_RUNTIME_PACKAGES.map((name) => [name, findTarball(name)]),
  );

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "takibi-e2e-consumer",
        private: true,
        type: "module",
        dependencies: {
          takibi: `file:${tarballs.takibi}`,
          "@takibi/hono-adapter": `file:${tarballs["@takibi/hono-adapter"]}`,
          hono: catalogVersion("hono"),
          zod: catalogVersion("zod"),
        },
        devDependencies: {
          "@cloudflare/workers-types": workersTypes,
          typescript: catalogVersion("typescript"),
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(consumerDir, ".npmrc"), "ignore-workspace=true\n");

  cpSync(join(e2eRoot, "consumer-template"), consumerDir, { recursive: true });
  cpSync(join(repoRoot, "examples/issue-tracker/src"), join(consumerDir, "app"), {
    recursive: true,
  });

  run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], consumerDir);
}
