import { tracing } from "cloudflare:workers";
import { expect, test } from "vite-plus/test";
import { createCloudflareTakibiTracer, type CloudflareTracing } from "@takibi/cloudflare-tracing";
import { createRecordingCloudflareTracing } from "./helpers/recording-tracing";

test("Workers enterSpan nests Takibi spans through async work", async () => {
  const recording = createRecordingCloudflareTracing();
  const wrapped: CloudflareTracing = {
    enterSpan(name, callback, ...args) {
      return recording.enterSpan(name, (span) =>
        tracing.enterSpan(name, () => callback(span, ...args)),
      );
    },
  };
  const tracer = createCloudflareTakibiTracer(wrapped);
  const request = tracer.startSpan({ name: "takibi.request", kind: "server" });
  const result = await request.runWithActiveContext(async () => {
    const resolve = tracer.startSpan({ name: "takibi.resolve", kind: "internal" }, request.context);
    return resolve.runWithActiveContext(async () => "ok");
  });

  expect(result).toBe("ok");
  expect(recording.spans.map((span) => span.name)).toEqual(["takibi.request", "takibi.resolve"]);
  expect(recording.spans[1]).toMatchObject({
    name: "takibi.resolve",
    parentName: "takibi.request",
    ended: true,
  });
});
