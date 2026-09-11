import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const srcDir = join(import.meta.dirname, "../src");

function specifiersIn(file: string): string[] {
  const source = readFileSync(join(srcDir, file), "utf8");
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

test("the fixture app only imports published Takibi entry points", () => {
  const manifest = JSON.parse(readFileSync(join(srcDir, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const runtimeDeps = Object.keys(manifest.dependencies ?? {});
  expect(runtimeDeps.sort()).toEqual(["@takibi/hono-adapter", "hono", "takibi", "zod"]);
  expect(JSON.stringify(manifest.devDependencies ?? {})).not.toMatch(/@takibi\//);

  expect(
    specifiersIn("handler.ts").filter((specifier) => specifier.startsWith("@takibi/")),
  ).toEqual([]);
  expect(
    specifiersIn("handler.ts").filter(
      (specifier) => specifier === "takibi" || specifier.startsWith("takibi/"),
    ),
  ).toEqual(["takibi"]);
  expect(
    specifiersIn("full-path-scenario.ts").filter((specifier) => specifier.startsWith("@takibi/")),
  ).toEqual(["@takibi/hono-adapter"]);
  expect(
    specifiersIn("full-path-scenario.ts").filter(
      (specifier) => specifier === "takibi" || specifier.startsWith("takibi/"),
    ),
  ).toEqual(["takibi", "takibi/client", "takibi/testing"]);
});
