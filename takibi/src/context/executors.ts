import type { ActionRegistry } from "../action";
import { executeAction } from "../action-executor";
import { seedCollections } from "../durable-object";
import { TakibiError } from "../errors";
import { executeOperation } from "../executor";
import type { PublicRequest } from "../http";
import { emitFailure, withLoggedSpan, type InternalLogger } from "../logging";
import { createMigratingStorage } from "../migrations";
import { batchSpanAttributes, invocationSpanAttributes, TAKIBI_SPAN } from "../otel-helper";
import {
  isBatchWireResponse,
  isWireResponse,
  type CollectionReadRequest,
  type WireRequest,
  type WireResponse,
} from "../protocol";
import { createMemoryStorage } from "../storage";
import {
  injectTraceparent,
  tracedStorage,
  type SpanContext,
  type SpanKind,
  type TakibiTracer,
} from "../tracing";
import type { CollectionsDef, StorageDriver } from "../types";
import {
  applyStorageLogging,
  debugInvocationFields,
  invocationFields,
  toWireFailure,
} from "./runtime";
import type { ContextStubResolver } from "./types";

export type ExecutorInput = {
  request: Request;
  /** Initial context from `handle(..., { context })`, before `resolve` ran. */
  initial: unknown;
  /** Resolved execution context (already asserted serializable). */
  ctx: Record<string, unknown>;
  invocation: PublicRequest;
  tracer: TakibiTracer | undefined;
  resolveSpan: SpanContext | undefined;
};

/**
 * Runs a decoded invocation against one storage backend (in-memory or a
 * Durable Object over the wire) and returns the wire-level result.
 */
export type Executor = (input: ExecutorInput) => Promise<WireResponse>;

export function createMemoryExecutor(
  collections: CollectionsDef<object>,
  registry: ActionRegistry,
  logger: InternalLogger | undefined,
): Executor {
  const driver = applyStorageLogging(
    createMigratingStorage(collections, createMemoryStorage(), logger),
    logger,
  );
  const ready = seedCollections(collections, driver, logger);

  return async ({ ctx, invocation, tracer, resolveSpan }) => {
    await ready;
    const storage = tracer ? tracedStorage(driver) : driver;
    if (invocation.kind === "batch") {
      return executeBatchReads({
        collections,
        storage,
        ctx,
        items: invocation.items,
        logger,
        resolveSpan,
        spanKind: "internal",
      });
    }
    const data = await withLoggedSpan(
      logger,
      {
        name: TAKIBI_SPAN.executor,
        kind: "internal",
        attributes: invocationSpanAttributes(invocation),
      },
      { event: "takibi.executor", ...debugInvocationFields(invocation) },
      () =>
        invocation.kind === "action"
          ? executeAction(registry, collections, storage, ctx, invocation, logger)
          : executeOperation(collections, storage, ctx, invocation, logger),
      resolveSpan,
    );
    return { ok: true, data };
  };
}

export function createStubExecutor<TInitial>(
  resolveStub: ContextStubResolver<object, TInitial> | undefined,
  logger: InternalLogger | undefined,
): Executor {
  return async ({ request, initial, ctx, invocation, resolveSpan }) => {
    if (!resolveStub) {
      throw new TakibiError(
        "MISSING_STUB",
        "Durable Object mode requires stub on createTakibi()({ stub }) — or use defineCollections(..., { memory: true }) for tests",
        500,
      );
    }
    const doStub = await resolveStub({ request, context: initial as TInitial, resolved: ctx });
    if (!doStub || typeof doStub.fetch !== "function") {
      throw new TakibiError(
        "MISSING_STUB",
        "createTakibi()({ stub }) did not return a Durable Object stub (use namespace.get(id))",
        500,
      );
    }

    const wire: WireRequest =
      invocation.kind === "batch"
        ? { kind: "batch", items: invocation.items, context: ctx }
        : { ...invocation, context: ctx };
    const itemCount = invocation.kind === "batch" ? invocation.items.length : undefined;
    return withLoggedSpan(
      logger,
      {
        name: TAKIBI_SPAN.wire,
        kind: "client",
        attributes:
          invocation.kind === "batch"
            ? batchSpanAttributes(invocation.items.length)
            : invocationSpanAttributes(invocation),
      },
      {
        event: "takibi.wire",
        ...(invocation.kind === "batch"
          ? { batchSize: invocation.items.length }
          : debugInvocationFields(invocation)),
      },
      async () => {
        const headers = new Headers({ "content-type": "application/json" });
        injectTraceparent(headers);
        const res = await doStub.fetch(
          new Request("https://takibi.internal/", {
            method: "POST",
            headers,
            body: JSON.stringify(wire),
          }),
        );
        const body: unknown = await res.json();
        if (itemCount !== undefined) {
          if (isWireResponse(body) && !body.ok) return body;
          if (!isBatchWireResponse(body, itemCount)) {
            throw new TakibiError(
              "INVALID_DO_RESPONSE",
              "Invalid response from Durable Object",
              500,
            );
          }
          return body;
        }
        if (!isWireResponse(body)) {
          throw new TakibiError("INVALID_DO_RESPONSE", "Invalid response from Durable Object", 500);
        }
        return body;
      },
      resolveSpan,
    );
  };
}

async function executeBatchReads(args: {
  collections: CollectionsDef<object>;
  storage: StorageDriver;
  ctx: Record<string, unknown>;
  items: CollectionReadRequest[];
  logger: InternalLogger | undefined;
  resolveSpan: SpanContext | undefined;
  spanKind: SpanKind;
}): Promise<WireResponse> {
  const results: WireResponse[] = [];
  for (const item of args.items) {
    results.push(await executeReadItem(args, item));
  }
  return { ok: true, data: results };
}

async function executeReadItem(
  args: {
    collections: CollectionsDef<object>;
    storage: StorageDriver;
    ctx: Record<string, unknown>;
    logger: InternalLogger | undefined;
    resolveSpan: SpanContext | undefined;
    spanKind: SpanKind;
  },
  item: CollectionReadRequest,
): Promise<WireResponse> {
  try {
    const data = await withLoggedSpan(
      args.logger,
      {
        name: TAKIBI_SPAN.executor,
        kind: args.spanKind,
        attributes: invocationSpanAttributes(item),
      },
      { event: "takibi.executor", ...debugInvocationFields(item) },
      () => executeOperation(args.collections, args.storage, args.ctx, item, args.logger),
      args.resolveSpan,
    );
    return { ok: true, data };
  } catch (error) {
    const wire = toWireFailure(error);
    emitFailure(args.logger, wire.error, invocationFields(item));
    return wire;
  }
}
