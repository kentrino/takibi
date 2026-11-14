/// <reference types="node" />
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const packageDir = join(import.meta.dirname, "..");

function specifiers(source: string): string[] {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...body.matchAll(/\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => (match[1] ?? match[2])!,
  );
}

test("the node:sqlite connection depends only on the storage port and Node built-ins", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
    private?: boolean;
    dependencies?: Record<string, string>;
  };
  expect(manifest.name).toBe("@takibi/node-sqlite");
  // Unpublished until the Node host gives it a use (RFC 0015).
  expect(manifest.private).toBe(true);
  expect(manifest.dependencies).toEqual({
    "@takibi/api": "workspace:^",
    "@takibi/storage": "workspace:^",
  });

  const imported = readdirSync(join(packageDir, "src"))
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => specifiers(readFileSync(join(packageDir, "src", file), "utf8")));
  expect(new Set(imported)).toEqual(
    new Set(["node:async_hooks", "node:sqlite", "@takibi/api", "@takibi/storage"]),
  );
});

test("the published build imports no Cloudflare or driver module", () => {
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(jsPath)) return;
  const js = readFileSync(jsPath, "utf8");
  expect(js).not.toContain("cloudflare:");
  expect(js).not.toContain("@libsql");
  expect(js).not.toContain("@takibi/worker-runtime");
});
