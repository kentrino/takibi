import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, test } from "vite-plus/test";

const srcDir = join(import.meta.dirname, "../src");
const forbiddenClientModules = [
  "tracing.ts",
  "context/index.ts",
  "schema.ts",
  "executor.ts",
  "storage.ts",
  "logging.ts",
  "instrumentation.ts",
] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectSpecifiers(source: string, valuesOnly: boolean): string[] {
  const body = stripComments(source);
  const specifiers: string[] = [];
  for (const match of body.matchAll(
    /(?:^|\n)[ \t]*((?:import|export)(?:\s+type)?[\s\S]*?\sfrom\s+)["']([^"']+)["']/g,
  )) {
    const statement = match[1] ?? "";
    const specifier = match[2];
    if (!specifier) continue;
    if (valuesOnly && /^(?:import|export)\s+type\b/.test(statement.trim())) continue;
    specifiers.push(specifier);
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
  return join(srcDir, "../..", name.replace("@takibi/", ""));
}

function resolveWorkspaceEntry(name: string, subpath = "."): string | undefined {
  const manifestPath = join(workspacePackageDir(name), "package.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: Record<string, string>;
  };
  const entry = manifest.exports?.[subpath];
  if (typeof entry !== "string") return undefined;
  return normalize(join(workspacePackageDir(name), entry));
}

function walkImports(entryFile: string, valuesOnly: boolean): Set<string> {
  const visited = new Set<string>();
  const queue = [normalize(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    const specifiers = collectSpecifiers(readFileSync(file, "utf8"), valuesOnly);
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:") || specifier.startsWith("cloudflare:")) {
        visited.add(specifier);
        continue;
      }
      if (specifier.startsWith(".")) {
        queue.push(resolveTsModule(file, specifier));
        continue;
      }
      visited.add(specifier);
      if (specifier.startsWith("@takibi/")) {
        const entry = resolveWorkspaceEntry(specifier);
        if (entry) queue.push(entry);
      }
    }
  }
  return visited;
}

function walkValueImports(entryFile: string): Set<string> {
  return walkImports(entryFile, true);
}

test("the browser entry static import graph stays off Worker modules", () => {
  const files = walkImports(join(srcDir, "client-entry.ts"), false);
  for (const name of forbiddenClientModules) {
    expect(files.has(normalize(join(srcDir, name))), name).toBe(false);
  }
  expect(files.has("node:async_hooks")).toBe(false);
  expect(files.has("cloudflare:workers")).toBe(false);
  expect(files.has("hono")).toBe(false);
  expect([...files].filter((file) => file.startsWith("node:"))).toEqual([]);
  expect([...files].filter((file) => file.startsWith("cloudflare:"))).toEqual([]);
  expect(files.has("@takibi/client")).toBe(true);
  expect(
    [...files].some((file) =>
      /(?:^|\/)(?:storage|logging|instrumentation|durable-object)/i.test(file),
    ),
  ).toBe(false);
});

test("published client facade declarations stay off Worker and Node types", () => {
  const dtsPath = join(srcDir, "../dist/client.d.mts");
  const jsPath = join(srcDir, "../dist/client.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  if (!js.includes("@takibi/client")) return;
  expect(js).toMatch(/@takibi\/client/);
  expect(dts).not.toContain("hono");
  expect(js).not.toContain("hono");
  expect(dts).not.toContain("node:");
  expect(js).not.toContain("node:");
  expect(dts).not.toContain("cloudflare:");
  expect(js).not.toContain("cloudflare:");
  expect(dts).not.toContain("DurableObject");
  expect(js).not.toContain("DurableObject");
});

test("the Worker root static import graph stays off Node compatibility modules", () => {
  const files = walkValueImports(join(srcDir, "index.ts"));
  expect([...files].filter((file) => file.startsWith("node:"))).toEqual([]);
  expect([...files].filter((file) => file.startsWith("@opentelemetry/"))).toEqual([]);
});

test("production entry graphs cannot reach the Node-only testing backend", () => {
  const testingEntry = normalize(join(srcDir, "testing.server.ts"));
  const productionEntries = [
    ["main", "index.ts"],
    ["client", "client-entry.ts"],
    ["instrumentation", "instrumentation.ts"],
  ] as const;

  for (const [name, entry] of productionEntries) {
    const files = walkValueImports(join(srcDir, entry));
    expect(files.has(testingEntry), `${name} reaches testing.server.ts`).toBe(false);
    expect(files.has("@takibi/testing"), `${name} reaches takibi-testing`).toBe(false);
    expect(files.has("node:sqlite"), `${name} reaches node:sqlite`).toBe(false);
  }
});

test("testing entry reaches Node SQLite only through the testing package", () => {
  const files = walkValueImports(join(srcDir, "testing.server.ts"));

  expect(files.has(normalize(join(srcDir, "testing.server.ts")))).toBe(true);
  expect(files.has("@takibi/testing")).toBe(true);
  expect(files.has("node:sqlite")).toBe(true);
  expect(existsSync(join(srcDir, "testing/sqlite-storage.server.ts"))).toBe(false);
});
