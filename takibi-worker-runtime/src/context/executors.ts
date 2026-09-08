import type { ActionRegistry, CollectionsDef } from "@takibi/takibi-api";
import { TakibiError } from "@takibi/takibi-api";
import type { PublicRequest } from "../http";
import { resolveLocalExecution } from "../invocation-execution";
import { withLoggedSpan, type InternalLogger } from "../logging";
import { batchSpanAttributes, invocationSpanAttributes, TAKIBI_SPAN } from "../otel-helper";
import {
  encodeWireRequest,
  isBatchWireResponse,
  isWireResponse,
  type WireRequest,
  type WireResponse,
} from "../protocol";
import { injectTraceparent, tracedStorage, type SpanContext, type TakibiTracer } from "../tracing";
import type { StorageDriver } from "@takibi/takibi-storage";
import { debugInvocationFields } from "./runtime";
import type { ContextStubResolver } from "./types";

export type ExecutorInput<TInitial = unknown> = {
  request: Request;
  /** Initial context from `handle(..., { context })`, before `resolve` ran. */
  initial: TInitial;
  /** Resolved execution context (already asserted serializable). */
  ctx: Record<string, unknown>;
  invocation: PublicRequest;
  tracer: TakibiTracer | undefined;
  resolveSpan: SpanContext | undefined;
};

/**
 * Runs a decoded invocation against one storage backend and returns the
 * wire-level result.
 */
export type Executor<TInitial = unknown> = (
  input: ExecutorInput<TInitial>,
) => Promise<WireResponse>;

export function createInProcessExecutor(
  collections: CollectionsDef<object>,
  registry: ActionRegistry,
  logger: InternalLogger | undefined,
  services: unknown,
  driver: StorageDriver,
  ready: Promise<void>,
): Executor {
  return async ({ request, ctx, invocation, tracer, resolveSpan }) => {
    await ready;
    const local = await resolveLocalExecution({
      collections,
      registry,
      logger,
      services,
      storage: tracer ? tracedStorage(driver) : driver,
      spanKind: "internal",
      parentSpan: resolveSpan,
      request,
    });
    if (invocation.kind === "batch") {
      return local.executeBatch(ctx, invocation.items);
    }
    return local.execute(ctx, invocation);
  };
}

export function createStubExecutor<TInitial>(
  resolveStub: ContextStubResolver<object, TInitial> | undefined,
  logger: InternalLogger | undefined,
): Executor<TInitial> {
  return async ({ request, initial, ctx, invocation, resolveSpan }) => {
    if (!resolveStub) {
      throw new TakibiError(
        "MISSING_STUB",
        "Durable Object mode requires stub on createTakibi()({ stub }); Node tests can use withSqliteTestBackend() from @takibi/takibi/testing",
        500,
      );
    }
    const doStub = await resolveStub({ request, context: initial, resolved: ctx });
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
            body: encodeWireRequest(wire),
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
