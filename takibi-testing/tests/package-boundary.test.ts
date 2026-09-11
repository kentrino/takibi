/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const extractedPackages = [
  "takibi-shared-types",
  "takibi-protocol",
  "takibi-query",
  "takibi-policy",
  "takibi-api",
  "takibi-client",
  "takibi-storage",
  "takibi-snapshot",
  "takibi-worker-runtime",
  "takibi-testing",
] as const;
const allowedWorkspace = new Set([
  "@takibi/takibi-api",
  "@takibi/takibi-storage",
  "@takibi/takibi-worker-runtime",
]);
const forbiddenSpecifiers = [
  "@takibi/takibi",
  "@takibi/takibi-client",
  "@takibi/takibi-execution-model",
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

function parseWorkspaceSpecifier(specifier: string): { name: string; subpath: string } | undefined {
  if (!specifier.startsWith("@takibi/")) return undefined;
  const rest = specifier.slice("@takibi/".length);
  const slash = rest.indexOf("/");
  if (slash === -1) return { name: `@takibi/${rest}`, subpath: "." };
  return { name: `@takibi/${rest.slice(0, slash)}`, subpath: `./${rest.slice(slash + 1)}` };
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
      const workspace = parseWorkspaceSpecifier(specifier);
      if (!workspace) continue;
      if (allowedWorkspace.has(workspace.name) || workspace.name === "@takibi/takibi-testing") {
        try {
          queue.push(resolveWorkspaceEntry(workspace.name, workspace.subpath));
        } catch {
          // Missing workspace package is reported by the specifier set.
        }
      }
    }
  }
  return visited;
}

test("testing package keeps a one-way dependency graph", () => {
  const testing = readManifest(join(packageDir, "package.json"));
  const api = readManifest(join(packagesDir, "takibi-api/package.json"));
  const client = readManifest(join(packagesDir, "takibi-client/package.json"));
  const storage = readManifest(join(packagesDir, "takibi-storage/package.json"));
  const snapshot = readManifest(join(packagesDir, "takibi-snapshot/package.json"));
  const workerRuntime = readManifest(join(packagesDir, "takibi-worker-runtime/package.json"));

  expect(testing.name).toBe("@takibi/takibi-testing");
  expect(testing.exports?.["."]).toBe("./src/index.ts");
  expect(testing.exports?.["./sqlite-storage"]).toBe("./src/sqlite-storage.server.ts");
  expect(testing.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(testing.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./sqlite-storage": {
      types: "./dist/sqlite-storage.d.mts",
      import: "./dist/sqlite-storage.mjs",
    },
  });
  expect(testing.dependencies).toEqual({
    "@takibi/takibi-api": "workspace:^",
    "@takibi/takibi-storage": "workspace:^",
    "@takibi/takibi-worker-runtime": "workspace:^",
  });
  expect(testing.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(testing.devDependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(testing.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(testing.dependencies?.["@takibi/takibi-execution-model"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/takibi-testing"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/takibi-testing"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/takibi-testing"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/takibi-testing"]).toBeUndefined();
  expect(workerRuntime.dependencies?.["@takibi/takibi-testing"]).toBeUndefined();
  expect(workerRuntime.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(workerRuntime.devDependencies?.["@takibi/takibi"]).toBeUndefined();
});

test("no extracted package has a production dependency on Takibi or execution-model", () => {
  for (const directory of extractedPackages) {
    const manifest = readManifest(join(packagesDir, `${directory}/package.json`));
    expect(manifest.dependencies?.["@takibi/takibi"]).toBeUndefined();
    expect(manifest.dependencies?.["@takibi/takibi-execution-model"]).toBeUndefined();
    expect(manifest.devDependencies?.["@takibi/takibi-execution-model"]).toBeUndefined();
  }
});

test("testing source consumes the runtime bridge and owns node:sqlite", () => {
  const reachable = walkGraph(join(packageDir, "src/index.ts"));

  expect(reachable.has(resolveWorkspaceEntry("@takibi/takibi-worker-runtime"))).toBe(true);
  expect(
    reachable.has(resolveWorkspaceEntry("@takibi/takibi-worker-runtime", "./testing-bridge")),
  ).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/takibi-api"))).toBe(true);
  expect(reachable.has(resolveWorkspaceEntry("@takibi/takibi-storage"))).toBe(true);
  expect(reachable.has("node:sqlite")).toBe(true);
  for (const specifier of forbiddenSpecifiers) {
    expect(reachable.has(specifier)).toBe(false);
  }
});

test("node:sqlite stays off Takibi production entries and worker-runtime", () => {
  const takibiSrc = join(packagesDir, "takibi/src");
  const runtimeSrc = join(packagesDir, "takibi-worker-runtime/src");
  const clientSrc = join(packagesDir, "takibi-client/src");
  const entries = [
    join(takibiSrc, "index.ts"),
    join(takibiSrc, "client-entry.ts"),
    join(takibiSrc, "instrumentation.ts"),
    join(runtimeSrc, "index.ts"),
    join(clientSrc, "index.ts"),
  ];

  for (const entry of entries) {
    const reachable = walkGraph(entry);
    expect(reachable.has("node:sqlite"), entry).toBe(false);
    expect(reachable.has("@takibi/takibi-testing"), entry).toBe(false);
  }
});

test("published testing declarations stay off Takibi and execution-model", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  const sqliteJsPath = join(packageDir, "dist/sqlite-storage.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath) || !existsSync(sqliteJsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  const sqliteJs = readFileSync(sqliteJsPath, "utf8");
  expect(dts).not.toMatch(/@takibi\/takibi(?:\/|"|'|$)/);
  expect(js).not.toMatch(/@takibi\/takibi(?:\/|"|'|$)/);
  expect(dts).not.toContain("@takibi/takibi-client");
  expect(js).not.toContain("@takibi/takibi-client");
  expect(dts).not.toContain("@takibi/takibi-execution-model");
  expect(js).not.toContain("@takibi/takibi-execution-model");
  expect(js).toContain("@takibi/takibi-worker-runtime/testing-bridge");
  expect(sqliteJs).toContain("node:sqlite");
});

test("source implementations have no duplicate generated declarations", () => {
  const files = new Set(readdirSync(join(packageDir, "src")));
  const duplicates = [...files].filter(
    (file) => file.endsWith(".d.ts") && files.has(file.replace(/\.d\.ts$/, ".ts")),
  );
  expect(
    duplicates,
    "Generate declarations in dist with vp pack, not beside source implementations",
  ).toEqual([]);
});
