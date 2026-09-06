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

test("protocol packages keep a one-way dependency graph", () => {
  const core = readManifest(join(import.meta.dirname, "../package.json"));
  const protocol = readManifest(join(import.meta.dirname, "../../takibi-protocol/package.json"));
  const api = readManifest(join(import.meta.dirname, "../../takibi-api/package.json"));
  const client = readManifest(join(import.meta.dirname, "../../takibi-client/package.json"));
  const policy = readManifest(join(import.meta.dirname, "../../takibi-policy/package.json"));
  const query = readManifest(join(import.meta.dirname, "../../takibi-query/package.json"));
  const storage = readManifest(join(import.meta.dirname, "../../takibi-storage/package.json"));
  const snapshot = readManifest(join(import.meta.dirname, "../../takibi-snapshot/package.json"));
  const sharedTypes = readManifest(
    join(import.meta.dirname, "../../takibi-shared-types/package.json"),
  );

  expect(core.dependencies?.["@takibi/takibi-api"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-client"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-policy"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-protocol"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-query"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-snapshot"]).toBe("workspace:^");
  expect(core.dependencies?.["@takibi/takibi-storage"]).toBe("workspace:^");
  expect(api.dependencies?.["@takibi/takibi-policy"]).toBe("workspace:^");
  expect(api.dependencies?.["@takibi/takibi-query"]).toBe("workspace:^");
  expect(api.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(api.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/takibi-storage"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/takibi-api"]).toBe("workspace:^");
  expect(client.dependencies?.["@takibi/takibi-query"]).toBe("workspace:^");
  expect(client.dependencies?.["@takibi/takibi-protocol"]).toBe("workspace:^");
  expect(client.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/takibi-storage"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(policy.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-query"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-protocol"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-api"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-storage"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/takibi-protocol"]).toBe("workspace:^");
  expect(query.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(query.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/takibi-policy"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/takibi-api"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/takibi-storage"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(protocol.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-query"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-policy"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-api"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-storage"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/takibi-api"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/takibi-protocol"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/takibi-query"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/takibi-policy"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/takibi-api"]).toBe("workspace:^");
  expect(snapshot.dependencies?.["@takibi/takibi-storage"]).toBe("workspace:^");
  expect(snapshot.dependencies?.["@takibi/takibi-shared-types"]).toBe("workspace:^");
  expect(snapshot.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/takibi-policy"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-snapshot"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-protocol"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-query"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-policy"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-api"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-client"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/takibi-storage"]).toBeUndefined();
});

test("instrumentation exports the stable Takibi telemetry vocabulary", () => {
  expect(TAKIBI_SPAN.wire).toBe("takibi.wire");
  expect(TAKIBI_ATTR.collection.name).toBe("takibi.collection.name");
});
