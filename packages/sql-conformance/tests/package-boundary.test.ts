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
    // Only the platform-neutral entry of the runtime, never its Durable Object root.
    expect(source, file).not.toMatch(/from\s+["']@takibi\/worker-runtime["']/);
  }
});

test("the suite and the Node connections build without Cloudflare types", () => {
  for (const directory of ["sql-conformance", "node-sqlite", "libsql"]) {
    const root = join(packageDir, "..", directory);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@cloudflare/workers-types"], directory).toBeUndefined();
    expect(manifest.devDependencies?.["@cloudflare/workers-types"], directory).toBeUndefined();
    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions?: { types?: string[] };
    };
    expect(tsconfig.compilerOptions?.types, directory).toEqual(["node"]);
  }
});
