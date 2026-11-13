/// <reference types="node" />
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const packageDir = join(import.meta.dirname, "..");
const packagesDir = join(packageDir, "..");

type Manifest = {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const manifest = (directory: string) =>
  JSON.parse(readFileSync(join(packagesDir, directory, "package.json"), "utf8")) as Manifest;

function specifiers(source: string): string[] {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...body.matchAll(/\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => (match[1] ?? match[2])!,
  );
}

test("only this package depends on the libSQL client", () => {
  const libsql = manifest("libsql");
  expect(libsql.name).toBe("@takibi/libsql");
  // Unpublished until the Node host gives it a use (RFC 0015).
  expect(libsql.private).toBe(true);
  expect(libsql.dependencies).toEqual({
    "@libsql/client": "catalog:",
    "@takibi/api": "workspace:^",
    "@takibi/storage": "workspace:^",
  });
  for (const directory of ["takibi", "storage", "worker-runtime", "snapshot", "node-sqlite"]) {
    const other = manifest(directory);
    expect(other.dependencies?.["@libsql/client"], directory).toBeUndefined();
    expect(other.devDependencies?.["@libsql/client"], directory).toBeUndefined();
    expect(other.dependencies?.["@takibi/libsql"], directory).toBeUndefined();
  }
});

test("the connection imports the storage port, the client, and no platform module", () => {
  const imported = readdirSync(join(packageDir, "src"))
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => specifiers(readFileSync(join(packageDir, "src", file), "utf8")));
  expect(new Set(imported)).toEqual(
    new Set([
      "node:async_hooks",
      "@libsql/client",
      "@takibi/api",
      "@takibi/storage",
      "./connection",
    ]),
  );
  const jsPath = join(packageDir, "dist/index.mjs");
  if (existsSync(jsPath)) {
    const js = readFileSync(jsPath, "utf8");
    expect(js).not.toContain("cloudflare:");
    expect(js).not.toContain("@takibi/worker-runtime");
  }
});
