import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "takibi";
import { withSqliteTestBackend } from "takibi/testing";
import type { TakibiTracer } from "takibi/instrumentation";
import {
  CloudflareTakibiInstrumentation,
  createCloudflareTakibiTracer,
  type CloudflareTracing,
} from "@takibi/cloudflare-tracing";
import { requestTakibi } from "./helpers/request";
import { createRecordingCloudflareTracing } from "./helpers/recording-tracing";

const Post = z.object({ title: z.string() });

afterEach(() => {
  new CloudflareTakibiInstrumentation().disable();
});

test("enterSpan records kind, attributes, errors, and async nesting", async () => {
  const recording = createRecordingCloudflareTracing();
  const tracer = createCloudflareTakibiTracer(recording);
  const request = tracer.startSpan({
    name: "takibi.request",
    kind: "server",
    attributes: { "takibi.collection.name": "posts" },
  });

  await request.runWithActiveContext(async () => {
    const resolve = tracer.startSpan({ name: "takibi.resolve", kind: "internal" }, request.context);
    await resolve.runWithActiveContext(async () => "ok");
    const policy = tracer.startSpan({ name: "takibi.policy", kind: "internal" }, request.context);
    await expect(
      policy.runWithActiveContext(async () => {
        const error = new Error("denied");
        policy.recordException({ name: error.name, message: error.message });
        policy.setStatus({ code: "error", message: error.message });
        throw error;
      }),
    ).rejects.toThrow("denied");
  });

  expect(recording.spans.map((span) => span.name)).toEqual([
    "takibi.request",
    "takibi.resolve",
    "takibi.policy",
  ]);
  expect(recording.spans[0]).toMatchObject({
    name: "takibi.request",
    attributes: {
      "span.kind": "server",
      "takibi.collection.name": "posts",
    },
    ended: true,
    endCount: 1,
  });
  expect(recording.spans[1]).toMatchObject({
    name: "takibi.resolve",
    parentName: "takibi.request",
    attributes: { "span.kind": "internal" },
    ended: true,
  });
  expect(recording.spans[2]).toMatchObject({
    name: "takibi.policy",
    parentName: "takibi.request",
    attributes: {
      "span.kind": "internal",
      "error.type": "Error",
      "error.message": "denied",
      "otel.status_code": "error",
    },
    ended: true,
  });
});

test("inject and extract stay no-ops", () => {
  const tracer = createCloudflareTakibiTracer(createRecordingCloudflareTracing());
  const headers = new Headers();
  tracer.inject(headers, {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    traceFlags: 1,
  });
  expect([...headers.keys()]).toEqual([]);
  expect(tracer.extract(new Headers({ traceparent: "00-a-b-01" }))).toBeUndefined();
});

test("enabled handler emits native enterSpan names for a public request", async () => {
  const recording = createRecordingCloudflareTracing();
  new CloudflareTakibiInstrumentation().enable(recording);
  const production = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const response = await requestTakibi(handler, "https://takibi.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "native" }),
  });
  expect(response.status).toBe(200);
  expect(recording.spans.map((span) => span.name)).toEqual(
    expect.arrayContaining([
      "takibi.request",
      "takibi.resolve",
      "takibi.executor",
      "takibi.policy",
      "takibi.schema",
      "takibi.storage",
    ]),
  );
  expect(recording.spans.every((span) => span.ended)).toBe(true);
  expect(recording.spans.find((span) => span.name === "takibi.resolve")).toMatchObject({
    parentName: "takibi.request",
  });
  expect(recording.spans.find((span) => span.name === "takibi.executor")).toMatchObject({
    parentName: "takibi.request",
  });
  expect(recording.spans.find((span) => span.name === "takibi.policy")).toMatchObject({
    parentName: "takibi.executor",
  });
});

test("disable leaves later requests uninstrumented", async () => {
  const recording = createRecordingCloudflareTracing();
  const instrumentation = new CloudflareTakibiInstrumentation();
  instrumentation.enable(recording);
  instrumentation.disable();
  const production = createTakibi()({
    resolve: () => ({ tenantId: "tenant-a" }),
  })
    .defineCollections({
      posts: { schema: Post, accessPolicy: fullAccess },
    })
    .actions({});
  const handler = withSqliteTestBackend(production);
  const response = await requestTakibi(handler, "https://takibi.test/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "silent" }),
  });
  expect(response.status).toBe(200);
  expect(recording.spans).toEqual([]);
});

test("public types stay on the Cloudflare tracing surface", () => {
  expectTypeOf<CloudflareTracing["enterSpan"]>().toBeFunction();
  expectTypeOf<TakibiTracer["startSpan"]>().toBeFunction();
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
  const source = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  expect(readme).toContain('from "@takibi/cloudflare-tracing"');
  expect(readme).toContain("CloudflareTakibiInstrumentation");
  expect(readme).toContain("createCloudflareTakibiTracer");
  expect(readme).toContain("enterSpan");
  expect(readme).toContain('from "cloudflare:workers"');
  expect(readme).toContain("observability");
  expect(readme).toContain("nodejs_compat");
  expect(readme).toContain("nodejs_als");
  expect(readme).toContain("does not need `nodejs_compat`");
  expect(readme).toContain("TAKIBI_SPAN");
  expect(source).not.toMatch(/from\s+["']cloudflare:workers["']/);
  expect(source).not.toContain("node:async_hooks");
  expect(source).not.toContain("startActiveSpan");
});
