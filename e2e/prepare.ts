import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const e2eRoot = join(repoRoot, "e2e");
export const tarballDir = join(e2eRoot, ".tarballs");
export const consumerDir = join(e2eRoot, ".consumer");
export const consumerTemplateDir = join(e2eRoot, "consumer-template");

export const PUBLIC_PACKAGES = [
  { dir: "packages/takibi", name: "takibi" },
  { dir: "packages/hono-adapter", name: "@takibi/hono-adapter" },
  { dir: "packages/better-auth-adapter", name: "@takibi/better-auth-adapter" },
  { dir: "packages/opentelemetry", name: "@takibi/opentelemetry" },
  { dir: "packages/cloudflare-tracing", name: "@takibi/cloudflare-tracing" },
] as const;

const CONSUMER_TARBALL_PACKAGES = [
  ...PUBLIC_PACKAGES,
  { dir: "examples/issue-tracker", name: "@takibi/issue-tracker" },
] as const;

const CONSUMER_RUNTIME_PACKAGES = [
  "takibi",
  "@takibi/hono-adapter",
  "@takibi/issue-tracker",
] as const;

type ConsumerManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

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
  const pattern = new RegExp(`^${stem}-\\d.*\\.tgz$`);
  const match = readdirSync(tarballDir).find((file) => pattern.test(file));
  if (!match) throw new Error(`missing tarball for ${name} in ${tarballDir}`);
  return join(tarballDir, match);
}

function expandCatalog(deps?: Record<string, string>): void {
  if (!deps) return;
  for (const [name, spec] of Object.entries(deps)) {
    if (spec.startsWith("catalog:")) deps[name] = catalogVersion(name);
  }
}

function rewritePackedConsumerManifest(manifest: ConsumerManifest): void {
  for (const deps of [manifest.dependencies, manifest.devDependencies]) {
    if (!deps) continue;
    for (const name of CONSUMER_RUNTIME_PACKAGES) {
      if (deps[name] !== undefined) deps[name] = `file:${findTarball(name)}`;
    }
    expandCatalog(deps);
    for (const [name, spec] of Object.entries(deps)) {
      if (spec.startsWith("workspace:")) {
        throw new Error(`packed consumer left workspace protocol on ${name}`);
      }
    }
  }
}

export function prepare(): void {
  rmSync(tarballDir, { recursive: true, force: true });
  rmSync(consumerDir, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });

  run("pnpm", [
    "--filter",
    "takibi",
    "--filter",
    "@takibi/hono-adapter",
    "--filter",
    "@takibi/better-auth-adapter",
    "--filter",
    "@takibi/opentelemetry",
    "--filter",
    "@takibi/cloudflare-tracing",
    "--filter",
    "@takibi/issue-tracker",
    "run",
    "build",
  ]);

  for (const pkg of CONSUMER_TARBALL_PACKAGES) {
    run("pnpm", ["pack", "--pack-destination", tarballDir], join(repoRoot, pkg.dir));
  }

  cpSync(consumerTemplateDir, consumerDir, { recursive: true });

  const manifestPath = join(consumerDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ConsumerManifest;
  rewritePackedConsumerManifest(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(consumerDir, ".npmrc"), "ignore-workspace=true\n");

  run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], consumerDir);
}
