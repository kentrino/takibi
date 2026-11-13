/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const packageDir = join(import.meta.dirname, "..");

test("the suite depends on the engine, never on a connection or a platform module", () => {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    private?: boolean;
    dependencies?: Record<string, string>;
  };
  expect(manifest.private).toBe(true);
  const dependencies = Object.keys(manifest.dependencies ?? {});
  for (const forbidden of ["@takibi/node-sqlite", "@takibi/libsql", "@libsql/client", "takibi"]) {
    expect(dependencies).not.toContain(forbidden);
  }

  for (const file of readdirSync(join(packageDir, "src"))) {
    const source = readFileSync(join(packageDir, "src", file), "utf8");
    expect(source, file).not.toMatch(/from\s+["'](?:cloudflare:|node:sqlite|@libsql\/)/);
  }
});
