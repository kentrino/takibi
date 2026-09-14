import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

type PackageManifest = {
  name: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
  publishConfig?: { exports?: Record<string, unknown>; access?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const packageDir = join(import.meta.dirname, "..");

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function sourceImports(file: string): string[] {
  const body = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [
    ...body.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...body.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
}

test("Cloudflare tracing adapter stays a takibi peer with no OpenTelemetry dependency", () => {
  const adapter = readManifest(join(packageDir, "package.json"));
  const core = readManifest(join(packageDir, "../takibi/package.json"));

  expect(adapter.name).toBe("@takibi/cloudflare-tracing");
  expect(adapter.private).toBeUndefined();
  expect(adapter.publishConfig?.access).toBe("public");
  expect(adapter.exports?.["."]).toBe("./src/index.ts");
  expect(adapter.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(adapter.repository).toEqual({
    type: "git",
    url: "git+https://github.com/kentrino/takibi.git",
    directory: "packages/cloudflare-tracing",
  });
  expect(adapter.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
  });
  expect(adapter.dependencies).toBeUndefined();
  expect(adapter.devDependencies?.takibi).toBe("workspace:*");
  expect(adapter.peerDependencies).toEqual({ takibi: "workspace:^" });
  expect(JSON.stringify(adapter)).not.toMatch(/opentelemetry/);
  expect(core.dependencies).toBeUndefined();
  expect(JSON.stringify(core.devDependencies ?? {})).not.toMatch(/cloudflare-tracing/);
  expect(JSON.stringify(core.peerDependencies ?? {})).not.toMatch(/cloudflare-tracing/);
});

test("runtime source imports only takibi instrumentation", () => {
  const specifiers = sourceImports(join(packageDir, "src/index.ts"));
  expect(specifiers).toEqual(["takibi/instrumentation"]);
  expect(readFileSync(join(packageDir, "wrangler.test.jsonc"), "utf8")).not.toContain(
    "nodejs_compat",
  );
});

test("published declarations stay on the takibi instrumentation contract", () => {
  const dtsPath = join(packageDir, "dist/index.d.mts");
  const jsPath = join(packageDir, "dist/index.mjs");
  if (!existsSync(dtsPath) || !existsSync(jsPath)) return;

  const dts = readFileSync(dtsPath, "utf8");
  const js = readFileSync(jsPath, "utf8");
  expect(dts).toContain("takibi/instrumentation");
  expect(js).toContain("takibi/instrumentation");
  expect(dts).not.toContain("@takibi/worker-runtime");
  expect(js).not.toContain("@takibi/worker-runtime");
  expect(dts).not.toContain("@opentelemetry");
  expect(js).not.toContain("@opentelemetry");
  expect(dts).not.toMatch(/from\s+["']cloudflare:workers["']/);
  expect(js).not.toMatch(/from\s+["']cloudflare:workers["']/);
  expect(dts).not.toContain("node:async_hooks");
  expect(js).not.toContain("node:async_hooks");
  expect(js).not.toContain("AsyncLocalStorage");
});
