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
  "@takibi/policy",
  "@takibi/protocol",
  "@takibi/query",
  "@takibi/shared-types",
]);
const forbiddenSpecifiers = [
  "takibi",
  "@takibi/storage",
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
      if (allowedWorkspace.has(specifier) || specifier === "@takibi/client") {
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

test("client package keeps a one-way dependency graph", () => {
  const client = readManifest(join(packageDir, "package.json"));
  const api = readManifest(join(packagesDir, "api/package.json"));
  const policy = readManifest(join(packagesDir, "policy/package.json"));
  const protocol = readManifest(join(packagesDir, "protocol/package.json"));
  const query = readManifest(join(packagesDir, "query/package.json"));
  const sharedTypes = readManifest(join(packagesDir, "shared-types/package.json"));

  expect(client.name).toBe("@takibi/client");
  expect(client.exports?.["."]).toBe("./src/index.ts");
  expect(client.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(client.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
  });
  expect(client.dependencies).toEqual({
    "@standard-schema/spec": "catalog:",
    "@takibi/api": "workspace:^",
    "@takibi/policy": "workspace:^",
    "@takibi/protocol": "workspace:^",
    "@takibi/query": "workspace:^",
    "@takibi/shared-types": "workspace:^",
  });
  expect(api.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(api.dependencies?.["takibi"]).toBeUndefined();
  expect(policy.dependencies?.["takibi"]).toBeUndefined();
  expect(protocol.dependencies?.["takibi"]).toBeUndefined();
  expect(query.dependencies?.["takibi"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["takibi"]).toBeUndefined();
});

test("client source and workspace exports stay browser-safe", () => {
  const reachable = walkGraph(join(packageDir, "src/index.ts"));

  expect(reachable.has(resolveWorkspaceEntry("@takibi/api"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/protocol"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/query"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/shared-types"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/policy"))).toBe(true);
  expect(reachable.has("@standard-schema/spec")).toBe(true);
  for (const specifier of forbiddenSpecifiers) {
    expect(reachable.has(specifier)).toBe(false);
  }
  expect([...reachable].filter((value) => value.startsWith("node:"))).toEqual([]);
  expect([...reachable].filter((value) => value.startsWith("cloudflare:"))).toEqual([]);
  expect(
    [...reachable].some((value) => /storage|logging|instrumentation|durable-object/i.test(value)),
  ).toBe(false);
});

test("published client declarations do not reference private or higher-layer paths", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).not.toMatch(/src\/client\.ts|src\/client-types\.ts/);
  expect(dts).not.toMatch(/["']takibi(?:\/[^"']*)?["']/);
  expect(js).not.toMatch(/["']takibi(?:\/[^"']*)?["']/);
  expect(dts).not.toContain("hono");
  expect(js).not.toContain("hono");
  expect(dts).not.toContain("node:");
  expect(js).not.toContain("node:");
  expect(dts).not.toContain("cloudflare:");
  expect(js).not.toContain("cloudflare:");
  expect(dts).not.toContain("DurableObject");
  expect(js).not.toContain("DurableObject");
  expect(dts).not.toContain("StorageDriver");
});
