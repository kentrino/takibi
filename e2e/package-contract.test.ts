import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTarball, PUBLIC_PACKAGES, tarballDir, tarballStem } from "./prepare.ts";

// Generic packaging and type-resolution checks are delegated to publint
// (lint-packed.ts) and attw (run.ts). This file only pins the Takibi-specific
// contract that those tools cannot know about.

type PackedManifest = {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

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

test("public packages ship publishable manifests without workspace internals", () => {
  assert.ok(tarballDir.endsWith("e2e/.tarballs"));

  for (const pkg of PUBLIC_PACKAGES) {
    const { files, manifest } = packedManifest(pkg.name);
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.private, undefined);
    assert.deepEqual(manifest.files, ["dist", "README.md", "LICENSE"]);
    for (const doc of ["package/README.md", "package/LICENSE"]) {
      assert.ok(files.includes(doc), `${pkg.name} tarball is missing ${doc}`);
    }
    assert.equal(
      files.some((file) => file.startsWith("package/src/")),
      false,
      `${pkg.name} tarball leaked src`,
    );
    assert.equal(JSON.stringify(manifest.exports ?? {}).includes("./src/"), false);
    for (const spec of dependencyValues(manifest)) {
      assert.doesNotMatch(spec, /^(?:workspace|catalog):/);
    }
  }
});

test("public packages expose the documented subpath entries", () => {
  const subpaths = (name: string): string[] =>
    Object.keys(packedManifest(name).manifest.exports ?? {});
  assert.deepEqual(subpaths("takibi"), [
    ".",
    "./client",
    "./instrumentation",
    "./testing",
    "./package.json",
  ]);
  assert.deepEqual(subpaths("@takibi/hono-adapter"), [".", "./package.json"]);
  assert.deepEqual(subpaths("@takibi/better-auth-adapter"), [".", "./package.json"]);
  assert.deepEqual(subpaths("@takibi/opentelemetry"), [".", "./logs", "./package.json"]);
});

test("packed takibi inlines workspace packages and keeps entry boundaries", () => {
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

test("packed adapters rewrite the workspace takibi peer to the packed version", () => {
  const takibiVersion = packedManifest("takibi").manifest.version;
  const expectedTakibiPeer = `^${takibiVersion}`;

  const hono = packedManifest("@takibi/hono-adapter");
  assert.equal(hono.manifest.peerDependencies?.takibi, expectedTakibiPeer);
  assert.equal(hono.manifest.peerDependencies?.hono, "^4.13.1");

  const betterAuth = packedManifest("@takibi/better-auth-adapter");
  assert.equal(betterAuth.manifest.peerDependencies?.takibi, expectedTakibiPeer);
  assert.doesNotMatch(JSON.stringify(betterAuth.manifest.peerDependencies ?? {}), /workspace:/);

  const otel = packedManifest("@takibi/opentelemetry");
  assert.equal(otel.manifest.peerDependencies?.takibi, expectedTakibiPeer);
});

test("tarball names stay scoped to the published package", () => {
  for (const pkg of PUBLIC_PACKAGES) {
    const tarball = findTarball(pkg.name);
    assert.match(tarball, new RegExp(`${tarballStem(pkg.name)}-\\d.*\\.tgz$`));
  }
});
