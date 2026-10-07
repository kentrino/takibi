import { AsyncLocalStorage } from "node:async_hooks";
import { expect } from "vite-plus/test";
import { z } from "zod";
import { createDurableObjectStorage, observeCommits, type StorageDriver } from "@takibi/storage";
import { createMigratingStorage } from "../src/migrations";
import { loggedStorage, resolveLogging } from "../src/logging";
import {
  bindTracer,
  registerTracingContextBackend,
  tracedStorage,
  type TracingContextBackend,
} from "../src/tracing";
import { createRecordingTracer } from "./helpers/recording-tracer";
import { createTrustedCollections } from "../src/executor";
import { fullAccess } from "../src/policy";

export const transactionCases = [
  "success",
  "admission",
  "callback",
  "nested",
  "commit",
  "unknown",
] as const;
export type TransactionCase = (typeof transactionCases)[number];
const collections = {
  items: { schema: z.object({ value: z.string() }), accessPolicy: fullAccess },
};

// Inject failures at the platform boundary. Unknown means commit succeeded but its
// acknowledgement was lost; commit means failure before commit, with rollback.
export function transactionBackend(
  raw: DurableObjectStorage,
  scenario: TransactionCase,
  error: Error,
): DurableObjectStorage {
  return new Proxy(raw, {
    get(target, property) {
      if (property === "transaction")
        return async <T>(callback: (tx: DurableObjectTransaction) => Promise<T>) => {
          if (scenario === "admission") throw error;
          const result = await target.transaction(async (tx) => {
            const value = await callback(tx);
            if (scenario === "commit") throw error;
            return value;
          });
          if (scenario === "unknown") throw error;
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const logger = resolveLogging({ logger: { log() {} }, logLevel: "debug" });
type TransactionWrapper = {
  wrap: (driver: StorageDriver) => StorageDriver;
  expectsSpans: boolean;
};

export const transactionWrappers: Record<string, TransactionWrapper> = {
  sqlite: { wrap: (driver) => driver, expectsSpans: false },
  migration: { wrap: (driver) => createMigratingStorage(collections, driver), expectsSpans: false },
  tracing: { wrap: tracedStorage, expectsSpans: true },
  logging: { wrap: (driver) => loggedStorage(driver, logger), expectsSpans: false },
  observation: { wrap: (driver) => observeCommits(driver, () => {}), expectsSpans: false },
  composed: {
    wrap: (driver) =>
      loggedStorage(
        tracedStorage(observeCommits(createMigratingStorage(collections, driver), () => {})),
        logger,
      ),
    expectsSpans: true,
  },
};

type ContractScope = {
  write(): Promise<void>;
  nested(callback: () => Promise<void>): Promise<void>;
};
type EntryPoint = (
  storage: StorageDriver,
  id: string,
  callback: (scope: ContractScope) => Promise<string>,
) => Promise<string>;

const entryPoints: Record<string, EntryPoint> = {
  driver: (storage, id, callback) =>
    storage.transaction((scope) =>
      callback({
        write: () =>
          scope.put("items", {
            id,
            value: "effect",
            rev: 1,
            createdAt: "2026-10-07",
            updatedAt: "2026-10-07",
          }),
        nested: (work) => scope.transaction(work),
      }),
    ),
  trusted: (storage, id, callback) =>
    createTrustedCollections(collections, storage).$transaction((scope) =>
      callback({
        write: async () => {
          await scope.items.add({ value: "effect" }, { id });
        },
        nested: (work) => scope.$transaction(work),
      }),
    ),
};

export async function checkTransactionCallbackContract(
  raw: DurableObjectStorage,
  wrapper: TransactionWrapper,
  scenario: TransactionCase,
): Promise<void> {
  const context = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();
  registerTracingContextBackend({
    getStore: () => context.getStore(),
    run: (store, fn) => context.run(store, fn),
  });
  const { tracer, spans } = createRecordingTracer();
  try {
    for (const [id, run] of Object.entries(entryPoints)) {
      await bindTracer(tracer, () => checkEntryPoint(raw, wrapper.wrap, scenario, id, run));
    }
    if (wrapper.expectsSpans) expect(spans.length).toBeGreaterThan(0);
  } finally {
    // Workers does not implement AsyncLocalStorage.disable(). The run scopes
    // have exited; remove the registered backend so no context is retained.
    registerTracingContextBackend(undefined);
  }
}

async function checkEntryPoint(
  raw: DurableObjectStorage,
  wrap: TransactionWrapper["wrap"],
  scenario: TransactionCase,
  id: string,
  run: EntryPoint,
): Promise<void> {
  const error = new Error(`injected ${scenario}`);
  const storage = wrap(createDurableObjectStorage(transactionBackend(raw, scenario, error)));
  const calls = { outer: 0, nested: 0 };
  const result = run(storage, id, async (scope) => {
    calls.outer++;
    await scope.write();
    await scope.nested(async () => {
      calls.nested++;
      if (scenario === "nested") throw error;
    });
    if (scenario === "callback") throw error;
    return "result";
  });
  if (scenario === "success") await expect(result).resolves.toBe("result");
  else await expect(result).rejects.toBe(error);
  expect(calls, "transaction callbacks must not be replayed").toEqual(
    scenario === "admission" ? { outer: 0, nested: 0 } : { outer: 1, nested: 1 },
  );
  const stored = await storage.get("items", id);
  if (scenario === "success" || scenario === "unknown") expect(stored?.id).toBe(id);
  else expect(stored).toBeNull();
}
