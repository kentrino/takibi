import { WATCH_PROTOCOL } from "@takibi/protocol";
import { WATCH_HEADER, encodeWatchAttachment, type WatchUpgrade } from "../watch-upgrade";
import type { ActionRegistry, CollectionsDef } from "@takibi/api";
import type { InternalLogger } from "../logging";
import type { TestingExecutorFactory } from "../testing-bridge.server";
import { createStubExecutor, resolveExecutionStub, type Executor } from "./executors";
import type { ContextStubResolver } from "./types";

export type Backend<TInitial = unknown, TCtx extends object = object> = {
  execute: Executor<TInitial, TCtx>;
  upgrade?: WatchUpgrade<TInitial, TCtx>;
  dispose?: () => void;
};

export type BackendInput<TCtx extends object = object> = {
  collections: CollectionsDef<TCtx>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
};

export type BackendFactory<TInitial = unknown, TCtx extends object = object> = (
  input: BackendInput<TCtx>,
) => Backend<TInitial, TCtx>;

export function stubBackend<TInitial, TCtx extends object>(
  stub: ContextStubResolver<TCtx, TInitial> | undefined,
): BackendFactory<TInitial, TCtx> {
  return ({ logger }) => ({
    execute: createStubExecutor(stub, logger),
    async upgrade({ request, initial, ctx, attachment }) {
      const target = await resolveExecutionStub(stub, request, initial, ctx);
      return target.fetch(
        new Request("https://takibi.internal/", {
          headers: {
            Upgrade: "websocket",
            "sec-websocket-protocol": WATCH_PROTOCOL,
            [WATCH_HEADER]: encodeURIComponent(encodeWatchAttachment(attachment)),
          },
        }),
      );
    },
  });
}

export function testingBackend<TInitial, TCtx extends object>(
  create: TestingExecutorFactory,
  services: unknown,
): BackendFactory<TInitial, TCtx> {
  return (input) => {
    const backend = create({ ...input, services });
    return { execute: backend.execute, dispose: () => backend.dispose() };
  };
}
