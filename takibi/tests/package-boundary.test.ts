import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { TAKIBI_ATTR, TAKIBI_SPAN } from "../src/instrumentation";

type PackageManifest = {
  name: string;
  files?: string[];
  exports?: Record<string, string>;
  publishConfig?: { exports?: Record<string, unknown> };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

test("OpenTelemetry integration has its own package dependency boundary", () => {
  const core = readManifest(join(import.meta.dirname, "../package.json"));
  const integration = readManifest(
    join(import.meta.dirname, "../../takibi-opentelemetry/package.json"),
  );

  expect(core.name).toBe("@takibi/takibi");
  expect(core.exports).not.toHaveProperty("./otel");
  expect(core.exports?.["./instrumentation"]).toBe("./src/instrumentation.ts");
  expect(core.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(core.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./client": { types: "./dist/client.d.mts", import: "./dist/client.mjs" },
    "./instrumentation": {
      types: "./dist/instrumentation.d.mts",
      import: "./dist/instrumentation.mjs",
    },
  });
  expect(JSON.stringify(core.dependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(JSON.stringify(core.devDependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(JSON.stringify(core.peerDependencies ?? {})).not.toMatch(/opentelemetry/);

  expect(integration.name).toBe("@takibi/takibi-opentelemetry");
  expect(integration.exports?.["."]).toBe("./src/index.ts");
  expect(integration.exports?.["./logs"]).toBe("./src/logs.ts");
  expect(integration.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(integration.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./logs": { types: "./dist/logs.d.mts", import: "./dist/logs.mjs" },
  });
  expect(integration.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(integration.devDependencies?.["@takibi/takibi"]).toBe("workspace:*");
  expect(integration.peerDependencies?.["@takibi/takibi"]).toBe("workspace:^");
  expect(integration.peerDependencies?.["@opentelemetry/api"]).toBe("^1.9.0");
  expect(integration.peerDependencies?.["@opentelemetry/api-logs"]).toBe("^0.221.0");
  expect(integration.peerDependenciesMeta?.["@opentelemetry/api"]?.optional).not.toBe(true);
  expect(integration.peerDependenciesMeta?.["@opentelemetry/api-logs"]?.optional).toBe(true);
});

test("core package exposes the Node-only testing subpath in source and published builds", () => {
  const core = readManifest(join(import.meta.dirname, "../package.json"));

  expect(core.exports?.["./testing"]).toBe("./src/testing.server.ts");
  expect(core.publishConfig?.exports).toMatchObject({
    "./testing": {
      types: "./dist/testing.d.mts",
      import: "./dist/testing.mjs",
    },
  });
});

test("instrumentation exports the stable Takibi telemetry vocabulary", () => {
  expect(TAKIBI_SPAN.wire).toBe("takibi.wire");
  expect(TAKIBI_ATTR.collection.name).toBe("takibi.collection.name");
});
