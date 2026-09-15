import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import {
  registerGlobalTracer,
  registerTracingContextBackend,
  type TracingContextBackend,
} from "takibi/instrumentation";
import { withSqliteTestBackend } from "takibi/testing";
import { createPolicyExample } from "./fixtures/local-policy";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  registerGlobalTracer(undefined);
  registerTracingContextBackend(undefined);
});

test("the SDK guide includes the type-checked local policy example", () => {
  const guide = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const example = readFileSync(new URL("./fixtures/local-policy.ts", import.meta.url), "utf8");
  expect(guide).toContain(`\x60\x60\x60ts\n${example}\x60\x60\x60`);
});

test("the example sends only resolved decision data to the selected tenant stub", async () => {
  const events: string[] = [];
  const handler = createPolicyExample();
  const result = await handler.handle(new Request("https://example.test/posts"), {
    context: {
      authenticate: async () => ({ userId: "u1", tenantId: "acme" }),
      loadMembership: async () => {
        await Promise.resolve();
        events.push("membership");
        return { canRead: true };
      },
      tenantStore: (tenantId) => {
        expect(tenantId).toBe("acme");
        events.push("stub");
        return {
          fetch: async (request) => {
            const wire = (await request.json()) as { context: unknown };
            expect(wire.context).toEqual({ userId: "u1", tenantId: "acme", canRead: true });
            events.push("fetch");
            return Response.json({ ok: true, data: { items: [] } });
          },
        };
      },
    },
  });
  expect(result.matched).toBe(true);
  if (!result.matched) throw new Error("Expected collection route");
  expect(result.response.status).toBe(200);
  expect(events).toEqual(["membership", "stub", "fetch"]);
});

test.each([true, false])(
  "resolve prepares decision inputs before dispatch and transaction (canRead=%s)",
  async (canRead) => {
    const events: string[] = [];
    const storage = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();
    registerTracingContextBackend(storage);
    registerGlobalTracer({
      startSpan(spec) {
        if (spec.name === "takibi.executor") events.push("dispatch");
        if (
          spec.name === "takibi.storage" &&
          spec.attributes?.["takibi.storage.operation"] === "transaction"
        )
          events.push("transaction");
        if (spec.name === "takibi.policy") events.push("policy");
        return {
          context: { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: 1 },
          runWithActiveContext: (fn) => fn(),
          recordException() {},
          setStatus() {},
          end() {},
        };
      },
      inject() {},
      extract: () => undefined,
    });
    using handler = withSqliteTestBackend(createPolicyExample());
    const membership = deferred<{ canRead: boolean }>();
    const started = deferred<void>();
    const response = handler.handle(new Request("https://example.test/posts"), {
      context: {
        authenticate: async () => ({ userId: "u1", tenantId: "acme" }),
        loadMembership: async (userId, tenantId) => {
          expect([userId, tenantId]).toEqual(["u1", "acme"]);
          events.push("membership:start");
          started.resolve(undefined);
          const result = await membership.promise;
          events.push("membership:end");
          return result;
        },
        tenantStore: () => {
          throw new Error("SQLite backend should execute locally");
        },
      },
    });
    await started.promise;
    expect(events).toEqual(["membership:start"]);
    membership.resolve({ canRead });
    const result = await response;
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("Expected collection route");
    expect(result.response.status).toBe(canRead ? 200 : 403);
    expect(events).toEqual([
      "membership:start",
      "membership:end",
      "dispatch",
      "transaction",
      "policy",
    ]);
  },
);
