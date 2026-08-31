import type { ActionRegistry } from "../action";
import type { InternalLogger, LoggingOptions } from "../logging";
import type { CollectionsDef } from "../types";
import type { Executor } from "./executors";

export type TestingForkOptions = LoggingOptions & {
  resolve?: (input: { request: Request; context: unknown }) => object | Promise<object>;
  services?: unknown;
};

export type TestingExecutorFactory = (input: {
  collections: CollectionsDef<object>;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
}) => {
  execute: Executor;
  dispose(): void;
};

export type TestingFork = (
  options: TestingForkOptions,
  createExecutor: TestingExecutorFactory,
) => unknown;

const testingForks = new WeakMap<object, TestingFork>();

export function registerTestingFork(handler: object, fork: TestingFork): void {
  testingForks.set(handler, fork);
}

export function getTestingFork(handler: object): TestingFork | undefined {
  return testingForks.get(handler);
}
