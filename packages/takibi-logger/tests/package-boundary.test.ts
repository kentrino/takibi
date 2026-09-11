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
const allowedWorkspace = new Set(["@takibi/takibi-shared-types"]);
const forbiddenSpecifiers = [
  "@takibi/takibi",
  "@takibi/takibi-api",
  "@takibi/takibi-client",
  "@takibi/takibi-policy",
  "@takibi/takibi-protocol",
  "@takibi/takibi-query",
  "@takibi/takibi-snapshot",
  "@takibi/takibi-storage",
  "@takibi/takibi-testing",
  "@takibi/takibi-utility",
  "@takibi/takibi-worker-runtime",
  "@takibi/takibi-worker-runtime-contract",
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
  for (const match of body.matchAll(
    /(?:^|\n)\s*(?:import|export)(?:\s+type)?\s+[\s\S]*?["']([^"']+)["']/g,
  )) {
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
      if (allowedWorkspace.has(specifier) || specifier === "@takibi/takibi-logger") {
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

test("logger package keeps a one-way dependency graph", () => {
  const logger = readManifest(join(packageDir, "package.json"));
  const sharedTypes = readManifest(join(packagesDir, "takibi-shared-types/package.json"));
  const contract = readManifest(join(packagesDir, "takibi-worker-runtime-contract/package.json"));
  const runtime = readManifest(join(packagesDir, "takibi-worker-runtime/package.json"));

  expect(logger.name).toBe("@takibi/takibi-logger");
  expect(logger.exports?.["."]).toBe("./src/index.ts");
  expect(logger.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(logger.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
  });
  expect(logger.dependencies).toEqual({
    "@takibi/takibi-shared-types": "workspace:^",
  });
  expect(sharedTypes.dependencies?.["@takibi/takibi-logger"]).toBeUndefined();
  expect(contract.dependencies?.["@takibi/takibi-logger"]).toBe("workspace:^");
  expect(runtime.dependencies?.["@takibi/takibi-logger"]).toBe("workspace:^");
  expect(logger.dependencies?.["@takibi/takibi-worker-runtime-contract"]).toBeUndefined();
  expect(logger.dependencies?.["@takibi/takibi-worker-runtime"]).toBeUndefined();
});

test("logger source stays off runtime, contract, and container libraries", () => {
  const reachable = walkGraph(join(packageDir, "src/index.ts"));

  expect(reachable.has(resolveWorkspaceEntry("@takibi/takibi-shared-types"))).toBe(true);
  for (const specifier of forbiddenSpecifiers) {
    expect(reachable.has(specifier)).toBe(false);
  }
  expect([...reachable].filter((value) => value.startsWith("node:"))).toEqual([]);
  expect([...reachable].filter((value) => value.startsWith("cloudflare:"))).toEqual([]);
});

test("published logger declarations do not import runtime or contract modules", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).not.toContain("@takibi/takibi-worker-runtime");
  expect(js).not.toContain("@takibi/takibi-worker-runtime");
  expect(dts).not.toContain("@takibi/takibi-worker-runtime-contract");
  expect(js).not.toContain("@takibi/takibi-worker-runtime-contract");
  expect(dts).not.toContain("hono");
  expect(js).not.toContain("hono");
  expect(dts).not.toContain("tatenuki");
  expect(js).not.toContain("tatenuki");
  expect(dts).not.toContain("node:");
  expect(js).not.toContain("node:");
});
