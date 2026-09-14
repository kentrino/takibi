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
  devDependencies?: Record<string, string>;
};

const packageDir = join(import.meta.dirname, "..");
const packagesDir = join(packageDir, "..");
const allowedWorkspace = new Set([
  "@takibi/api",
  "@takibi/invocation-lifecycle",
  "@takibi/logger",
  "@takibi/policy",
  "@takibi/protocol",
  "@takibi/query",
  "@takibi/shared-types",
  "@takibi/snapshot",
  "@takibi/storage",
  "@takibi/utility",
]);
const forbiddenSpecifiers = [
  "takibi",
  "@takibi/client",
  "@takibi/testing",
  "@takibi/execution-model",
  "@takibi/worker-runtime-contract",
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
      if (allowedWorkspace.has(specifier) || specifier === "@takibi/worker-runtime") {
        try {
          const subpath = specifier === "@takibi/worker-runtime" ? "." : ".";
          queue.push(resolveWorkspaceEntry(specifier, subpath));
        } catch {
          // Missing workspace package is reported by the specifier set.
        }
      }
    }
  }
  return visited;
}

test("worker-runtime package keeps a one-way dependency graph", () => {
  const runtime = readManifest(join(packageDir, "package.json"));
  const api = readManifest(join(packagesDir, "api/package.json"));
  const client = readManifest(join(packagesDir, "client/package.json"));
  const policy = readManifest(join(packagesDir, "policy/package.json"));
  const query = readManifest(join(packagesDir, "query/package.json"));
  const protocol = readManifest(join(packagesDir, "protocol/package.json"));
  const storage = readManifest(join(packagesDir, "storage/package.json"));
  const snapshot = readManifest(join(packagesDir, "snapshot/package.json"));
  const sharedTypes = readManifest(join(packagesDir, "shared-types/package.json"));

  expect(runtime.name).toBe("@takibi/worker-runtime");
  expect(runtime.exports?.["."]).toBe("./src/index.ts");
  expect(runtime.exports?.["./instrumentation"]).toBe("./src/instrumentation.ts");
  expect(runtime.exports?.["./testing-bridge"]).toBe("./src/testing-bridge.server.ts");
  expect(runtime.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(runtime.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./instrumentation": {
      types: "./dist/instrumentation.d.mts",
      import: "./dist/instrumentation.mjs",
    },
    "./testing-bridge": {
      types: "./dist/testing-bridge.d.mts",
      import: "./dist/testing-bridge.mjs",
    },
  });
  expect(runtime.dependencies).toEqual({
    "@standard-schema/spec": "catalog:",
    "@takibi/api": "workspace:^",
    "@takibi/invocation-lifecycle": "workspace:^",
    "@takibi/logger": "workspace:^",
    "@takibi/policy": "workspace:^",
    "@takibi/protocol": "workspace:^",
    "@takibi/query": "workspace:^",
    "@takibi/shared-types": "workspace:^",
    "@takibi/snapshot": "workspace:^",
    "@takibi/storage": "workspace:^",
    "@takibi/utility": "workspace:^",
    tatenuki: "catalog:",
  });
  expect(runtime.dependencies?.hono).toBeUndefined();
  expect(runtime.dependencies?.["takibi"]).toBeUndefined();
  expect(runtime.devDependencies?.["takibi"]).toBeUndefined();
  expect(runtime.devDependencies?.["@takibi/testing"]).toBeUndefined();
  expect(runtime.devDependencies?.["@takibi/client"]).toBe("workspace:*");
  expect(api.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
});

test("worker-runtime source stays off client, testing, execution-model, and Node modules", () => {
  const reachable = walkGraph(join(packageDir, "src/index.ts"));

  expect(reachable.has(resolveWorkspaceEntry("@takibi/api"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/logger"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/policy"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/storage"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/snapshot"))).toBe(true);
  for (const specifier of forbiddenSpecifiers) {
    expect(reachable.has(specifier)).toBe(false);
  }
  expect([...reachable].filter((value) => value.startsWith("node:"))).toEqual([]);
});

test("published runtime declarations do not import Node or higher-layer modules", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).not.toMatch(/["']takibi(?:\/[^"']*)?["']/);
  expect(js).not.toMatch(/["']takibi(?:\/[^"']*)?["']/);
  expect(dts).not.toContain("node:");
  expect(js).not.toContain("node:");
  expect(dts).not.toContain("@takibi/client");
  expect(js).not.toContain("@takibi/client");
  expect(dts).not.toContain("@takibi/testing");
  expect(js).not.toContain("@takibi/testing");
  expect(dts).not.toContain("@takibi/execution-model");
  expect(js).not.toContain("@takibi/execution-model");
});
