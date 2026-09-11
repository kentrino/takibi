/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, test } from "vite-plus/test";

type PackageManifest = {
  name: string;
  files?: string[];
  exports?: Record<string, string>;
  publishConfig?: { exports?: Record<string, unknown> };
  dependencies?: Record<string, string>;
};

const packageDir = join(import.meta.dirname, "..");
const packagesDir = join(packageDir, "..");
const allowedWorkspace = new Set([
  "@takibi/api",
  "@takibi/logger",
  "@takibi/policy",
  "@takibi/query",
  "@takibi/shared-types",
]);
const forbiddenSpecifiers = [
  "takibi",
  "@takibi/client",
  "@takibi/storage",
  "@takibi/snapshot",
  "@takibi/worker-runtime",
  "@takibi/testing",
  "hono",
  "tatenuki",
];

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectSpecifiers(source: string): string[] {
  const body = stripComments(source);
  const specifiers: string[] = [];
  for (const match of body.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of body.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of body.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveTsModule(fromFile: string, specifier: string): string {
  if (specifier.endsWith(".ts") || specifier.endsWith(".mts") || specifier.endsWith(".mjs")) {
    return normalize(join(dirname(fromFile), specifier));
  }
  const asFile = normalize(join(dirname(fromFile), `${specifier}.ts`));
  if (existsSync(asFile)) return asFile;
  return normalize(join(dirname(fromFile), specifier, "index.ts"));
}

function workspacePackageDir(name: string): string {
  return join(packagesDir, name.replace("@takibi/", ""));
}

function resolveWorkspaceEntry(name: string, subpath = "."): string {
  const manifest = readManifest(join(workspacePackageDir(name), "package.json"));
  const entry = manifest.exports?.[subpath];
  if (typeof entry !== "string") {
    throw new Error(`Missing export ${subpath} on ${name}`);
  }
  return normalize(join(workspacePackageDir(name), entry));
}

function walkGraph(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const queue = [normalize(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    for (const specifier of collectSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:")) {
        visited.add(specifier);
        continue;
      }
      if (specifier.startsWith(".")) {
        queue.push(resolveTsModule(file, specifier));
        continue;
      }
      visited.add(specifier);
      if (allowedWorkspace.has(specifier) || specifier === "@takibi/worker-runtime-contract") {
        try {
          queue.push(resolveWorkspaceEntry(specifier));
        } catch {
          // Missing workspace package is reported by the specifier set.
        }
      }
    }
  }
  return visited;
}

test("contract package keeps a one-way dependency graph", () => {
  const contract = readManifest(join(packageDir, "package.json"));
  const api = readManifest(join(packagesDir, "api/package.json"));
  const policy = readManifest(join(packagesDir, "policy/package.json"));
  const sharedTypes = readManifest(join(packagesDir, "shared-types/package.json"));
  const runtime = readManifest(join(packagesDir, "worker-runtime/package.json"));

  expect(contract.name).toBe("@takibi/worker-runtime-contract");
  expect(contract.exports?.["."]).toBe("./src/index.ts");
  expect(contract.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(contract.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
  });
  expect(contract.dependencies).toEqual({
    "@standard-schema/spec": "catalog:",
    "@takibi/api": "workspace:^",
    "@takibi/logger": "workspace:^",
    "@takibi/policy": "workspace:^",
    "@takibi/shared-types": "workspace:^",
  });
  expect(api.dependencies?.["@takibi/worker-runtime-contract"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/worker-runtime-contract"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/worker-runtime-contract"]).toBeUndefined();
  expect(runtime.dependencies?.["@takibi/worker-runtime-contract"]).toBe("workspace:^");
});

test("contract source stays off runtime, storage, and container libraries", () => {
  const reachable = walkGraph(join(packageDir, "src/index.ts"));

  expect(reachable.has(resolveWorkspaceEntry("@takibi/api"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/logger"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/policy"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/shared-types"))).toBe(true);
  expect(reachable.has("@standard-schema/spec")).toBe(true);
  for (const specifier of forbiddenSpecifiers) {
    expect(reachable.has(specifier)).toBe(false);
  }
  expect([...reachable].filter((value) => value.startsWith("node:"))).toEqual([]);
  expect([...reachable].filter((value) => value.startsWith("cloudflare:"))).toEqual([]);
});

test("published contract declarations do not import runtime or higher-layer modules", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).not.toContain("@takibi/worker-runtime");
  expect(js).not.toContain("@takibi/worker-runtime");
  expect(dts).not.toContain("tatenuki");
  expect(js).not.toContain("tatenuki");
  expect(dts).not.toContain("hono");
  expect(js).not.toContain("hono");
  expect(dts).not.toContain("node:");
  expect(js).not.toContain("node:");
});
