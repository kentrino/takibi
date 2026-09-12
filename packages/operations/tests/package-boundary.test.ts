/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import * as operations from "../src";

const packageDir = resolve(import.meta.dirname, "..");
const packagesDir = dirname(packageDir);

test("package exports execution entry points, not individual operation classes", () => {
  expect(Object.keys(operations)).toEqual(["prepareCollection"]);
});

function manifest(dir: string) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
}

test("operations has no direct or transitive dependency on the worker runtime", () => {
  const visited = new Set<string>();
  const pending = ["@takibi/operations"];
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    expect(["takibi", "@takibi/worker-runtime", "@takibi/testing"]).not.toContain(name);
    const dir = join(packagesDir, name.replace("@takibi/", ""));
    for (const dependency of Object.keys(manifest(dir).dependencies ?? {})) {
      if (dependency === "takibi" || dependency.startsWith("@takibi/")) {
        pending.push(dependency);
      }
    }
  }
});

test("operation source imports only local files or declared dependencies", () => {
  const dependencies = Object.keys(manifest(packageDir).dependencies);
  const src = join(packageDir, "src");
  for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const path = join(src, file);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        expect(relative(src, resolve(dirname(path), specifier)).startsWith("..")).toBe(false);
      } else {
        expect(dependencies).toContain(specifier);
      }
    }
  }
});
