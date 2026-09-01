import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { SeverityNumber, type LogRecord, type Logger as OtelLogger } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { createTakibi, fullAccess } from "@takibi/takibi";
import { withSqliteTestBackend } from "@takibi/takibi/testing";
import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import { TakibiInstrumentation } from "../src/index";
import { createOtelLogger } from "../src/logs";

class AsyncLocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(activeContext, () => fn.call(thisArg, ...args));
  }

  bind<T>(_context: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

function capturingOtelLogger(records: LogRecord[]): OtelLogger {
  return {
    emit(record) {
      records.push(record);
    },
    enabled() {
      return true;
    },
  };
}

test("logs adapter preserves event fields and active OpenTelemetry context", () => {
  const records: LogRecord[] = [];
  const logger = createOtelLogger(capturingOtelLogger(records));
  const manager = new AsyncLocalContextManager();
  context.setGlobalContextManager(manager);
  try {
    const spanContext = {
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      traceFlags: TraceFlags.SAMPLED,
    };
    context.with(trace.setSpanContext(context.active(), spanContext), () => {
      logger.log({
        level: "error",
        event: "takibi.error",
        message: "Not found",
        collection: "posts",
        operation: "get",
        documentId: "p1",
        method: "GET",
        path: "/posts/p1",
        durationMs: 1.5,
        errorCode: "NOT_FOUND",
        status: 404,
        query: { field: "ownerId", op: "eq", value: "u1" },
      });
    });
    logger.log({
      level: "info",
      event: "takibi.request",
      message: "completed",
      status: 200,
      batchSize: 2,
    });

    expect(records[0]).toMatchObject({
      eventName: "takibi.error",
      body: "Not found",
      severityText: "ERROR",
      severityNumber: SeverityNumber.ERROR,
      attributes: {
        "takibi.event.name": "takibi.error",
        "takibi.collection.name": "posts",
        "takibi.operation.name": "get",
        "takibi.document.id": "p1",
        "takibi.http.method": "GET",
        "takibi.http.path": "/posts/p1",
        "takibi.duration.ms": 1.5,
        "takibi.error.code": "NOT_FOUND",
        "takibi.response.status": 404,
        "takibi.query": '{"field":"ownerId","op":"eq","value":"u1"}',
      },
    });
    expect(trace.getSpanContext(records[0]!.context!)).toEqual(spanContext);
    expect(records[1]?.attributes).toMatchObject({
      "takibi.event.name": "takibi.request",
      "takibi.response.status": 200,
      "takibi.batch.size": 2,
    });
    expect(trace.getSpanContext(records[1]!.context!)).toBeUndefined();
    expectTypeOf(createOtelLogger).returns.toHaveProperty("log");
  } finally {
    context.disable();
  }
});

test("logs entrypoint is optional and absent from the tracing import graph", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
    exports: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
    publishConfig: { exports: Record<string, unknown> };
  };
  const tracingSource = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");

  expect(pkg.exports["./logs"]).toBe("./src/logs.ts");
  expect(pkg.publishConfig.exports).toHaveProperty("./logs");
  expect(pkg.peerDependenciesMeta["@opentelemetry/api-logs"]?.optional).toBe(true);
  expect(tracingSource).not.toContain("@opentelemetry/api-logs");
  expect(tracingSource).not.toContain("./logs");
});

test("Takibi request and stage logs carry their active span", async () => {
  const records: LogRecord[] = [];
  const manager = new AsyncLocalContextManager();
  const provider = new BasicTracerProvider();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const instrumentation = new TakibiInstrumentation();
  instrumentation.enable();
  try {
    const baseHandler = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      logger: createOtelLogger(capturingOtelLogger(records)),
      logLevel: "debug",
    })
      .defineCollections({
        posts: {
          schema: z.object({ title: z.string() }),
          accessPolicy: fullAccess,
        },
      })
      .actions({});
    const handler = withSqliteTestBackend(baseHandler);
    const response = await handler.request("https://takibi.test/posts/p1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "observed" }),
    });
    expect(response.status).toBe(200);

    const resolveRecord = records.find(({ eventName }) => eventName === "takibi.resolve");
    const resolveSpan = trace.getSpanContext(resolveRecord!.context!);
    expect(resolveSpan?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveSpan?.spanId).toMatch(/^[0-9a-f]{16}$/);
    const requestRecords = records.filter(({ eventName }) => eventName === "takibi.request");
    expect(requestRecords).toHaveLength(2);
    const requestContexts = requestRecords.map((record) => trace.getSpanContext(record.context!));
    expect(requestContexts[0]?.traceId).toBe(resolveSpan?.traceId);
    expect(requestContexts[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(requestContexts[1]).toEqual(requestContexts[0]);
  } finally {
    instrumentation.disable();
    propagation.disable();
    trace.disable();
    context.disable();
    await provider.shutdown();
  }
});

test("request failures correlate one error record to the request trace", async () => {
  const records: LogRecord[] = [];
  const manager = new AsyncLocalContextManager();
  const provider = new BasicTracerProvider();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const instrumentation = new TakibiInstrumentation();
  instrumentation.enable();
  const logger = createOtelLogger(capturingOtelLogger(records));
  try {
    const cases: Array<{ name: string; request: () => Promise<Response> }> = [];

    const decodeProductionHandler = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      logger,
      logLevel: "info",
    })
      .defineCollections({
        posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
      })
      .actions({});
    const decodeHandler = withSqliteTestBackend(decodeProductionHandler);
    cases.push({
      name: "decode",
      request: async () =>
        decodeHandler.request("https://takibi.test/posts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
    });

    const resolveProductionHandler = createTakibi()({
      resolve: (): { tenantId: string } => {
        throw new Error("resolve failed");
      },
      logger,
      logLevel: "info",
    })
      .defineCollections({
        posts: { schema: z.object({ title: z.string() }), accessPolicy: fullAccess },
      })
      .actions({});
    const resolveHandler = withSqliteTestBackend(resolveProductionHandler);
    cases.push({
      name: "resolve",
      request: async () => resolveHandler.request("https://takibi.test/posts/p1"),
    });

    const sqliteApp = createTakibi()({
      resolve: () => ({ tenantId: "tenant-a" }),
      logger,
      logLevel: "info",
    }).defineCollections({});
    const sqliteProductionHandler = sqliteApp.actions({
      $: {
        boom: sqliteApp
          .defineAction()
          .policy(fullAccess)
          .handler(() => {
            throw new Error("SQLite executor failed");
          }),
      },
    });
    const sqliteHandler = withSqliteTestBackend(sqliteProductionHandler);
    cases.push({
      name: "SQLite executor",
      request: async () =>
        sqliteHandler.request("https://takibi.test/$:boom", {
          method: "POST",
        }),
    });

    for (const testCase of cases) {
      records.length = 0;
      const response = await testCase.request();
      expect(response.status, testCase.name).toBeGreaterThanOrEqual(400);
      const requestRecord = records.find(({ eventName }) => eventName === "takibi.request");
      const errorRecords = records.filter(({ eventName }) => eventName === "takibi.error");
      expect(errorRecords, testCase.name).toHaveLength(1);
      const requestContext = trace.getSpanContext(requestRecord!.context!);
      const errorContext = trace.getSpanContext(errorRecords[0]!.context!);
      expect(requestContext?.traceId, testCase.name).toMatch(/^[0-9a-f]{32}$/);
      expect(errorContext?.traceId, testCase.name).toBe(requestContext?.traceId);
    }
  } finally {
    instrumentation.disable();
    propagation.disable();
    trace.disable();
    context.disable();
    await provider.shutdown();
  }
});
