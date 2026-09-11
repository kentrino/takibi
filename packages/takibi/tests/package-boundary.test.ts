import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { TAKIBI_ATTR, TAKIBI_SPAN } from "../src/instrumentation";

type PackageManifest = {
  name: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, string>;
  publishConfig?: { exports?: Record<string, unknown>; access?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  inlinedDependencies?: Record<string, string>;
};

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

test("OpenTelemetry integration has its own package dependency boundary", () => {
  const core = readManifest(join(import.meta.dirname, "../package.json"));
  const integration = readManifest(join(import.meta.dirname, "../../opentelemetry/package.json"));

  expect(core.name).toBe("takibi");
  expect(core.private).toBeUndefined();
  expect(core.publishConfig?.access).toBe("public");
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

  expect(integration.name).toBe("@takibi/opentelemetry");
  expect(integration.private).toBeUndefined();
  expect(integration.publishConfig?.access).toBe("public");
  expect(integration.exports?.["."]).toBe("./src/index.ts");
  expect(integration.exports?.["./logs"]).toBe("./src/logs.ts");
  expect(integration.files).toEqual(["dist", "README.md", "LICENSE"]);
  expect(integration.publishConfig?.exports).toMatchObject({
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./logs": { types: "./dist/logs.d.mts", import: "./dist/logs.mjs" },
  });
  expect(integration.dependencies?.["takibi"]).toBeUndefined();
  expect(integration.devDependencies?.["takibi"]).toBe("workspace:*");
  expect(integration.peerDependencies?.["takibi"]).toBe("workspace:^");
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
  const protocol = readManifest(join(import.meta.dirname, "../../protocol/package.json"));
  const api = readManifest(join(import.meta.dirname, "../../api/package.json"));
  const client = readManifest(join(import.meta.dirname, "../../client/package.json"));
  const policy = readManifest(join(import.meta.dirname, "../../policy/package.json"));
  const query = readManifest(join(import.meta.dirname, "../../query/package.json"));
  const storage = readManifest(join(import.meta.dirname, "../../storage/package.json"));
  const snapshot = readManifest(join(import.meta.dirname, "../../snapshot/package.json"));
  const workerRuntime = readManifest(
    join(import.meta.dirname, "../../worker-runtime/package.json"),
  );
  const testing = readManifest(join(import.meta.dirname, "../../testing/package.json"));
  const sharedTypes = readManifest(join(import.meta.dirname, "../../shared-types/package.json"));

  expect(core.dependencies).toBeUndefined();
  expect(core.devDependencies?.["@takibi/api"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/client"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/logger"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/policy"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/protocol"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/query"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/snapshot"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/storage"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/testing"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/utility"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/worker-runtime"]).toBe("workspace:^");
  expect(core.devDependencies?.["@takibi/worker-runtime-contract"]).toBe("workspace:^");
  expect(core.devDependencies?.hono).toBe("catalog:");
  expect(core.devDependencies?.["@standard-schema/spec"]).toBe("catalog:");
  expect(Object.keys(core.inlinedDependencies ?? {}).sort()).toEqual([
    "@noble/hashes",
    "@standard-schema/spec",
    "tatenuki",
  ]);
  expect(api.private).toBe(true);
  expect(client.private).toBe(true);
  expect(policy.private).toBe(true);
  expect(query.private).toBe(true);
  expect(protocol.private).toBe(true);
  expect(storage.private).toBe(true);
  expect(snapshot.private).toBe(true);
  expect(workerRuntime.private).toBe(true);
  expect(testing.private).toBe(true);
  expect(sharedTypes.private).toBe(true);
  expect(api.dependencies?.["@takibi/policy"]).toBe("workspace:^");
  expect(api.dependencies?.["@takibi/query"]).toBe("workspace:^");
  expect(api.dependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(api.dependencies?.["takibi"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/api"]).toBe("workspace:^");
  expect(client.dependencies?.["@takibi/query"]).toBe("workspace:^");
  expect(client.dependencies?.["@takibi/protocol"]).toBe("workspace:^");
  expect(client.dependencies?.["takibi"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(policy.dependencies?.["takibi"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/query"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/protocol"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/api"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/protocol"]).toBe("workspace:^");
  expect(query.dependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(query.dependencies?.["takibi"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/policy"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/api"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(protocol.dependencies?.["takibi"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/query"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/policy"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/api"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/storage"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/api"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/protocol"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/query"]).toBe("workspace:^");
  expect(storage.dependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(storage.dependencies?.["takibi"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/policy"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/api"]).toBe("workspace:^");
  expect(snapshot.dependencies?.["@takibi/storage"]).toBe("workspace:^");
  expect(snapshot.dependencies?.["@takibi/shared-types"]).toBe("workspace:^");
  expect(snapshot.dependencies?.["takibi"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/policy"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(workerRuntime.dependencies?.["@takibi/api"]).toBe("workspace:^");
  expect(workerRuntime.dependencies?.["@takibi/policy"]).toBe("workspace:^");
  expect(workerRuntime.dependencies?.["@takibi/query"]).toBe("workspace:^");
  expect(workerRuntime.dependencies?.["@takibi/protocol"]).toBe("workspace:^");
  expect(workerRuntime.dependencies?.["@takibi/storage"]).toBe("workspace:^");
  expect(workerRuntime.dependencies?.["@takibi/snapshot"]).toBe("workspace:^");
  expect(workerRuntime.dependencies?.["takibi"]).toBeUndefined();
  expect(workerRuntime.devDependencies?.["takibi"]).toBeUndefined();
  expect(workerRuntime.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(testing.dependencies?.["@takibi/api"]).toBe("workspace:^");
  expect(testing.dependencies?.["@takibi/storage"]).toBe("workspace:^");
  expect(testing.dependencies?.["@takibi/worker-runtime"]).toBe("workspace:^");
  expect(testing.dependencies?.["takibi"]).toBeUndefined();
  expect(testing.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(testing.devDependencies?.["takibi"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/testing"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/testing"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/testing"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/testing"]).toBeUndefined();
  expect(workerRuntime.dependencies?.["@takibi/testing"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(storage.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(snapshot.dependencies?.["@takibi/worker-runtime"]).toBeUndefined();
  expect(api.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(client.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(policy.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(query.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(protocol.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/snapshot"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["takibi"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/protocol"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/query"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/policy"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/api"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/client"]).toBeUndefined();
  expect(sharedTypes.dependencies?.["@takibi/storage"]).toBeUndefined();
});

test("instrumentation exports the stable Takibi telemetry vocabulary", () => {
  expect(TAKIBI_SPAN.wire).toBe("takibi.wire");
  expect(TAKIBI_ATTR.collection.name).toBe("takibi.collection.name");
});

test("worker-runtime testing-bridge is a dedicated owner subpath", () => {
  const runtime = readManifest(join(import.meta.dirname, "../../worker-runtime/package.json"));
  expect(runtime.exports?.["./testing-bridge"]).toBe("./src/testing-bridge.server.ts");
  const core = readManifest(join(import.meta.dirname, "../package.json"));
  expect(core.exports).not.toHaveProperty("./testing-bridge");
});

test("only the SDK and adapters are publishable", () => {
  const honoAdapter = readManifest(join(import.meta.dirname, "../../hono-adapter/package.json"));
  const betterAuth = readManifest(
    join(import.meta.dirname, "../../better-auth-adapter/package.json"),
  );

  expect(honoAdapter.private).toBeUndefined();
  expect(honoAdapter.publishConfig?.access).toBe("public");
  expect(honoAdapter.dependencies ?? {}).toEqual({});
  expect(honoAdapter.peerDependencies?.takibi).toBe("workspace:^");
  expect(honoAdapter.peerDependencies?.hono).toBe("^4.13.1");

  expect(betterAuth.private).toBeUndefined();
  expect(betterAuth.publishConfig?.access).toBe("public");
  expect(betterAuth.peerDependencies?.takibi).toBe("workspace:^");

  const issueTracker = readManifest(
    join(import.meta.dirname, "../../../examples/issue-tracker/package.json"),
  );
  expect(issueTracker.private).toBe(true);
  expect(issueTracker.dependencies?.takibi).toBe("workspace:^");
  expect(issueTracker.dependencies?.["@takibi/hono-adapter"]).toBe("workspace:^");
  expect(issueTracker.dependencies?.["@takibi/protocol"]).toBeUndefined();
});
