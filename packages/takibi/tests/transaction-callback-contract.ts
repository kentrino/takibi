import { expect } from "vite-plus/test";
import { z } from "zod";
import { createDurableObjectStorage, observeCommits, type StorageDriver } from "@takibi/storage";
import { createMigratingStorage } from "../src/migrations";
import { loggedStorage, resolveLogging } from "../src/logging";
import { tracedStorage } from "../src/tracing";
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
export const transactionWrappers: Record<string, (driver: StorageDriver) => StorageDriver> = {
  sqlite: (driver) => driver,
  migration: (driver) => createMigratingStorage(collections, driver),
  tracing: tracedStorage,
  logging: (driver) => loggedStorage(driver, logger),
  observation: (driver) => observeCommits(driver, () => {}),
  composed: (driver) =>
    loggedStorage(
      tracedStorage(observeCommits(createMigratingStorage(collections, driver), () => {})),
      logger,
    ),
};

export async function checkTransactionCallbackContract(
  raw: DurableObjectStorage,
  wrap: (driver: StorageDriver) => StorageDriver,
  scenario: TransactionCase,
  id: string,
  trusted = false,
): Promise<void> {
  const error = new Error(`injected ${scenario}`);
  const storage = wrap(createDurableObjectStorage(transactionBackend(raw, scenario, error)));
  const calls = { outer: 0, nested: 0 };
  const result = trusted
    ? createTrustedCollections(collections, storage).$transaction(async (scope) => {
        calls.outer++;
        await scope.items.add({ value: "effect" }, { id });
        await scope.$transaction(async () => {
          calls.nested++;
          if (scenario === "nested") throw error;
        });
        if (scenario === "callback") throw error;
        return "result";
      })
    : storage.transaction(async (scope) => {
        calls.outer++;
        await scope.put("items", {
          id,
          value: "effect",
          rev: 1,
          createdAt: "2026-10-07",
          updatedAt: "2026-10-07",
        });
        await scope.transaction(async () => {
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
