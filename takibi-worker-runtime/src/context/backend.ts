import type { ActionRegistry, CollectionsDef } from "@takibi/takibi-api";
import type { InternalLogger } from "../logging";
import type { TestingExecutorFactory } from "../testing-bridge.server";
import { createStubExecutor, type Executor } from "./executors";
import type { ContextStubResolver } from "./types";

export type Backend = {
  execute: Executor;
  dispose?: () => void;
};

export type BackendInput = {
  collections: CollectionsDef<object>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
};

export type BackendFactory = (input: BackendInput) => Backend;

export function stubBackend(
  stub: ContextStubResolver<object, unknown> | undefined,
): BackendFactory {
  return ({ logger }) => ({ execute: createStubExecutor(stub, logger) });
}

export function testingBackend(create: TestingExecutorFactory, services: unknown): BackendFactory {
  return (input) => {
    const backend = create({ ...input, services });
    return { execute: backend.execute, dispose: () => backend.dispose() };
  };
}
