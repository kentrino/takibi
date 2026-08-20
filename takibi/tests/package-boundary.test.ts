import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

type PackageManifest = {
  name: string;
  exports?: Record<string, string>;
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
  expect(JSON.stringify(core.dependencies ?? {})).not.toMatch(/opentelemetry/);
  expect(JSON.stringify(core.peerDependencies ?? {})).not.toMatch(/opentelemetry/);

  expect(integration.name).toBe("@takibi/takibi-opentelemetry");
  expect(integration.exports?.["."]).toBe("./src/index.ts");
  expect(integration.dependencies?.["@takibi/takibi"]).toBe("workspace:*");
  expect(integration.peerDependencies?.["@opentelemetry/api"]).toBe("^1.9.0");
  expect(integration.peerDependenciesMeta?.["@opentelemetry/api"]?.optional).not.toBe(true);
});
