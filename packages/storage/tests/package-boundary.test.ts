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
  "@takibi/protocol",
  "@takibi/query",
  "@takibi/shared-types",
]);
const forbiddenSpecifiers = [
  "takibi",
  "@takibi/client",
  "@takibi/snapshot",
  "@takibi/worker-runtime",
  "@takibi/testing",
  "hono",
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
      if (allowedWorkspace.has(specifier) || specifier === "@takibi/storage") {
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

test("storage package keeps a one-way dependency graph", () => {
  const storage = readManifest(join(packageDir, "package.json"));
  const api = readManifest(join(packagesDir, "api/package.json"));
  const protocol = readManifest(join(packagesDir, "protocol/package.json"));
  const query = readManifest(join(packagesDir, "query/package.json"));
  const sharedTypes = readManifest(join(packagesDir, "shared-types/package.json"));

  expect(storage.name).toBe("@takibi/storage");
  expect(storage.exports?.["."]).toBe("./src/index.ts");
  expect(storage.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(storage.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
  });
  expect(storage.dependencies).toEqual({
    "@takibi/api": "workspace:^",
    "@takibi/protocol": "workspace:^",
    "@takibi/query": "workspace:^",
    "@takibi/shared-types": "workspace:^",
    "@takibi/utility": "workspace:^",
  });
  expect(api.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(api.dependencies?.["takibi"]).toBeUndefined();
  expect(protocol.dependencies?.["takibi"]).toBeUndefined();
  expect(query.dependencies?.["takibi"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["takibi"]).toBeUndefined();
});

test("storage source stays off higher layers and Node or Worker runtime modules", () => {
  const reachable = walkGraph(join(packageDir, "src/index.ts"));

  expect(reachable.has(resolveWorkspaceEntry("@takibi/api"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/protocol"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/query"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/shared-types"))).toBe(true);
  for (const specifier of forbiddenSpecifiers) {
    expect(reachable.has(specifier)).toBe(false);
  }
  expect([...reachable].filter((value) => value.startsWith("node:"))).toEqual([]);
  expect([...reachable].filter((value) => value.startsWith("cloudflare:"))).toEqual([]);
});

test("published storage declarations do not import higher-layer or runtime modules", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).not.toMatch(/src\/storage\.ts|src\/indexes\.ts|src\/sql-query\.ts/);
  expect(dts).not.toMatch(/["']takibi(?:\/[^"']*)?["']/);
  expect(js).not.toMatch(/["']takibi(?:\/[^"']*)?["']/);
  expect(dts).not.toContain("hono");
  expect(js).not.toContain("hono");
  expect(dts).not.toContain("node:");
  expect(js).not.toContain("node:");
  expect(dts).not.toContain("cloudflare:");
  expect(js).not.toContain("cloudflare:");
  expect(dts).not.toContain("@takibi/policy");
  expect(js).not.toContain("@takibi/policy");
});
