import { expect, test, vi } from "vite-plus/test";
import type { CollectionDefinition } from "@takibi/api";
import { fullAccess } from "@takibi/policy";
import type { StorageDriver } from "@takibi/storage";
import type { OperationAdapters } from "@takibi/operations";
import { createPolicyCollections, createTrustedCollections } from "../src/collections";
const definition: CollectionDefinition = {
  schema: {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
    },
  },
  accessPolicy: () => fullAccess,
};

function storage() {
  const driver = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
    list: vi.fn(async () => ({ items: [] })),
    async transaction<T>(_callback: (scope: StorageDriver) => Promise<T>): Promise<T> {
      throw new Error("Operations must not start transactions");
    },
  } satisfies StorageDriver;
  return driver;
}

function adapters(): OperationAdapters {
  return {
    policy: { evaluateCollection: vi.fn(async () => fullAccess) },
    documents: {
      buildAdd: vi.fn(async (_def, _input, options) => ({
        id: options!.id!,
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
        rev: 1,
      })),
      buildSet: vi.fn(async () => {
        throw new Error("Unexpected set");
      }),
      buildUpdate: vi.fn(async () => {
        throw new Error("Unexpected update");
      }),
    },
  };
}

test("policy API prepares add before opening its transaction and writes in that scope", async () => {
  const events: string[] = [];
  const scoped = storage();
  const root: StorageDriver = {
    ...storage(),
    async transaction<T>(callback: (scope: StorageDriver) => Promise<T>): Promise<T> {
      events.push("transaction");
      return callback(scoped);
    },
  };
  const api = createPolicyCollections(
    {
      notes: {
        ...definition,
        accessPolicy: () => {
          events.push("policy");
          return fullAccess;
        },
      },
    },
    root,
    {},
  );
  await api.notes.add({}, { id: "added" });
  expect(events).toEqual(["policy", "transaction"]);
  expect(scoped.put).toHaveBeenCalledExactlyOnceWith(
    "notes",
    expect.objectContaining({ id: "added" }),
  );
});

test("trusted bulk updates reuse the transaction supplied by the API", async () => {
  const dependencies = adapters();
  const original = await dependencies.documents.buildAdd(definition, {}, { id: "bulk" });
  const scoped = {
    ...storage(),
    list: vi.fn(async () => ({ items: [original] })),
  };
  let transactions = 0;
  const root: StorageDriver = {
    ...storage(),
    async transaction<T>(callback: (scope: StorageDriver) => Promise<T>): Promise<T> {
      transactions += 1;
      return callback(scoped);
    },
  };
  const api = createTrustedCollections({ notes: definition }, root);
  await expect(
    api.$transaction((tx) =>
      tx.notes.updateMany({ title: "updated" }, { where: (query) => query.id.eq("bulk") }),
    ),
  ).resolves.toEqual({ updated: 1 });
  expect(transactions).toBe(1);
  expect(scoped.put).toHaveBeenCalledExactlyOnceWith(
    "notes",
    expect.objectContaining({ id: "bulk", title: "updated", rev: 2 }),
  );
});
