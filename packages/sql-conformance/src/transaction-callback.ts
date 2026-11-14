import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  openSqliteStorage,
  observeCommits,
  SqlExecutor,
  sqlCommitOutcomeUnknown,
  type StorageDriver,
} from "@takibi/storage";
import { fullAccess } from "@takibi/policy";
import {
  bindTracer,
  createMigratingStorage,
  createTrustedCollections,
  loggedStorage,
  registerTracingContextBackend,
  resolveLogging,
  tracedStorage,
  type TakibiTracer,
  type TracingContextBackend,
} from "@takibi/worker-runtime/tenant-runtime";
import type { ConformanceTarget } from "./target";

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

// Inject failures at the platform boundary (the SQL port). Unknown means commit
// succeeded but its acknowledgement was lost; commit means failure before commit,
// with rollback. Injection is armed after storage layout initialization, which
// also runs in a port transaction, so only transactions under test fail.
export async function injectedTransactionStorage(
  raw: SqlExecutor,
  scenario: TransactionCase,
  error: Error,
): Promise<StorageDriver> {
  let armed = false;
  const executor = new SqlExecutor({
    exec: (query, ...bindings) => raw.exec(query, ...bindings),
    read: (query, ...bindings) => raw.read(query, ...bindings),
    async transaction(callback) {
      if (!armed) return raw.transaction(callback);
      if (scenario === "admission") throw error;
      const result = await raw.transaction(async (tx) => {
        const value = await callback(tx);
        if (scenario === "commit") throw error;
        return value;
      });
      if (scenario === "unknown") throw error;
      return result;
    },
  });
  const storage = await openSqliteStorage(executor);
  armed = true;
  return storage;
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
  raw: SqlExecutor,
  wrapper: TransactionWrapper,
  scenario: TransactionCase,
): Promise<void> {
  const context = new AsyncLocalStorage<Parameters<TracingContextBackend["run"]>[0]>();
  registerTracingContextBackend({
    getStore: () => context.getStore(),
    run: (store, fn) => context.run(store, fn),
  });
  const { tracer, spans } = countingTracer();
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
  raw: SqlExecutor,
  wrap: TransactionWrapper["wrap"],
  scenario: TransactionCase,
  id: string,
  run: EntryPoint,
): Promise<void> {
  // An unknown outcome is reported the way a connection reports it.
  const error =
    scenario === "unknown" ? sqlCommitOutcomeUnknown() : new Error(`injected ${scenario}`);
  const storage = wrap(await injectedTransactionStorage(raw, scenario, error));
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

/** A tracer that only records which spans started. */
function countingTracer(): { tracer: TakibiTracer; spans: string[] } {
  const spans: string[] = [];
  const tracer: TakibiTracer = {
    startSpan(spec, parent) {
      spans.push(spec.name);
      return {
        context: {
          traceId: parent?.traceId ?? "0".repeat(31) + "1",
          spanId: "0".repeat(15) + "1",
          traceFlags: 1,
        },
        runWithActiveContext: (fn) => fn(),
        recordException() {},
        setStatus() {},
        end() {},
      };
    },
    inject() {},
    extract: () => undefined,
  };
  return { tracer, spans };
}

/**
 * The transaction callback no-replay contract (RFC 0003) for every supported
 * storage wrapper, entry point, and failure injected at the SQL port.
 */
export function defineTransactionCallbackTests(target: ConformanceTarget): void {
  describe("transaction callbacks are never replayed", () => {
    for (const [name, wrapper] of Object.entries(transactionWrappers)) {
      for (const scenario of transactionCases) {
        test(`${name}: ${scenario}`, () =>
          target.withDatabase(`callback-${name}-${scenario}`, (sql) =>
            checkTransactionCallbackContract(sql, wrapper, scenario),
          ));
      }
    }
    // The check itself must notice a replay, or every case above passes vacuously.
    test("the check detects a wrapper that replays the callback", () =>
      target.withDatabase("callback-replaying-wrapper", async (sql) => {
        const replaying: TransactionWrapper = {
          expectsSpans: false,
          wrap: (driver) => ({
            ...driver,
            transaction: (callback) =>
              driver.transaction(async (scope) => {
                await callback(scope);
                return callback(scope);
              }),
          }),
        };
        await expect(checkTransactionCallbackContract(sql, replaying, "success")).rejects.toThrow(
          "transaction callbacks must not be replayed",
        );
      }));
  });
}
