import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTarball, PUBLIC_PACKAGES, repoRoot, tarballDir, tarballStem } from "./prepare.ts";

type PackedManifest = {
  name: string;
  version?: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  repository?: { url?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function publishedTakibiVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "packages/takibi/package.json"), "utf8"),
  ) as {
    version: string;
  };
  return manifest.version;
}

function tarList(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
}

function tarText(tarball: string, innerPath: string): string {
  return execFileSync("tar", ["-xOf", tarball, innerPath], { encoding: "utf8" });
}

function packedManifest(name: string): {
  tarball: string;
  files: string[];
  manifest: PackedManifest;
} {
  const tarball = findTarball(name);
  const files = tarList(tarball);
  const manifest = JSON.parse(tarText(tarball, "package/package.json")) as PackedManifest;
  return { tarball, files, manifest };
}

function dependencyValues(manifest: PackedManifest): string[] {
  return [
    ...Object.values(manifest.dependencies ?? {}),
    ...Object.values(manifest.peerDependencies ?? {}),
    ...Object.values(manifest.optionalDependencies ?? {}),
    ...Object.values(manifest.devDependencies ?? {}),
  ];
}

test("every public package packs the published export map", () => {
  assert.ok(tarballDir.endsWith("e2e/.tarballs"));

  for (const pkg of PUBLIC_PACKAGES) {
    const { files, manifest } = packedManifest(pkg.name);
    const source = JSON.parse(readFileSync(join(repoRoot, pkg.dir, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, source.version);
    assert.equal(manifest.private, undefined);
    assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE"]);
    assert.ok(files.includes("package/package.json"));
    assert.ok(files.includes("package/README.md"));
    assert.ok(files.includes("package/LICENSE"));
    assert.ok(files.some((file) => file.startsWith("package/dist/") && file.endsWith(".mjs")));
    assert.ok(files.some((file) => file.startsWith("package/dist/") && file.endsWith(".d.mts")));
    assert.equal(
      files.some((file) => file.startsWith("package/src/")),
      false,
      `${pkg.name} tarball leaked src`,
    );
    assert.equal(JSON.stringify(manifest.exports ?? {}).includes("./src/"), false);
    assert.match(JSON.stringify(manifest.repository ?? {}), /github\.com\/kentrino\/takibi/);
    for (const spec of dependencyValues(manifest)) {
      assert.doesNotMatch(spec, /^(?:workspace|catalog):/);
    }
  }
});

test("packed takibi inlines workspace packages and keeps entry boundaries", () => {
  const { files, manifest } = packedManifest("takibi");
  assert.equal(manifest.version, publishedTakibiVersion());
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./client": { types: "./dist/client.d.mts", import: "./dist/client.mjs" },
    "./instrumentation": {
      types: "./dist/instrumentation.d.mts",
      import: "./dist/instrumentation.mjs",
    },
    "./testing": { types: "./dist/testing.d.mts", import: "./dist/testing.mjs" },
    "./package.json": "./package.json",
  });
  for (const file of [
    "package/dist/index.mjs",
    "package/dist/index.d.mts",
    "package/dist/client.mjs",
    "package/dist/client.d.mts",
    "package/dist/instrumentation.mjs",
    "package/dist/instrumentation.d.mts",
    "package/dist/testing.mjs",
    "package/dist/testing.d.mts",
  ]) {
    assert.ok(files.includes(file), file);
  }

  const indexJs = tarText(findTarball("takibi"), "package/dist/index.mjs");
  const indexDts = tarText(findTarball("takibi"), "package/dist/index.d.mts");
  const clientJs = tarText(findTarball("takibi"), "package/dist/client.mjs");
  const clientDts = tarText(findTarball("takibi"), "package/dist/client.d.mts");
  const testingJs = tarText(findTarball("takibi"), "package/dist/testing.mjs");

  assert.doesNotMatch(indexJs, /from\s+["']@takibi\//);
  assert.doesNotMatch(indexDts, /from\s+["']@takibi\//);
  assert.doesNotMatch(clientJs, /from\s+["']@takibi\//);
  assert.doesNotMatch(clientDts, /from\s+["']@takibi\//);
  assert.doesNotMatch(clientJs, /node:/);
  assert.doesNotMatch(clientDts, /node:/);
  assert.doesNotMatch(clientJs, /cloudflare:/);
  assert.doesNotMatch(clientDts, /cloudflare:/);
  assert.doesNotMatch(clientJs, /hono/);
  assert.doesNotMatch(clientDts, /hono/);
  assert.doesNotMatch(clientJs, /DurableObject/);
  assert.doesNotMatch(clientDts, /DurableObject/);
  assert.match(testingJs, /node:sqlite/);
});

test("packed adapter manifests rewrite workspace peers", () => {
  const takibiPeer = `^${publishedTakibiVersion()}`;
  const hono = packedManifest("@takibi/hono-adapter");
  assert.deepEqual(hono.manifest.exports, {
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./package.json": "./package.json",
  });
  assert.equal(hono.manifest.peerDependencies?.takibi, takibiPeer);
  assert.equal(hono.manifest.peerDependencies?.hono, "^4.13.1");

  const betterAuth = packedManifest("@takibi/better-auth-adapter");
  assert.equal(betterAuth.manifest.peerDependencies?.takibi, takibiPeer);
  assert.doesNotMatch(JSON.stringify(betterAuth.manifest.peerDependencies ?? {}), /workspace:/);

  const otel = packedManifest("@takibi/opentelemetry");
  assert.ok(otel.files.includes("package/dist/logs.mjs"));
  assert.ok(otel.files.includes("package/dist/logs.d.mts"));
  assert.equal(otel.manifest.peerDependencies?.takibi, takibiPeer);
});

test("tarball names stay scoped to the published package", () => {
  for (const pkg of PUBLIC_PACKAGES) {
    const tarball = findTarball(pkg.name);
    assert.match(tarball, new RegExp(`${tarballStem(pkg.name)}-\\d.*\\.tgz$`));
  }
});
