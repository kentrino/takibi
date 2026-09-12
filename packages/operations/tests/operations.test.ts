import { expect, test, vi } from "vite-plus/test";
import { NotFoundError, type CollectionDefinition } from "@takibi/api";
import { fullAccess } from "@takibi/policy";
import type { StorageDriver } from "@takibi/storage";
import { prepareCollection, type OperationAdapters } from "../src";
import { AddOperation } from "../src/add";
import type { OperationContext } from "../src/types";

const definition: CollectionDefinition = {
  schema: {
    "~standard": { version: 1, vendor: "test", validate: () => ({ value: {} }) },
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

function context(id: string) {
  return {
    req: { kind: "collection", collection: "notes", operation: "add", id, input: {} },
    ctx: { actor: id },
    collections: { notes: definition },
    def: definition,
    storage: storage(),
  } satisfies OperationContext<{ actor: string }>;
}

test("one operation instance keeps concurrent invocation state separate", async () => {
  const dependencies = adapters();
  const operation = new AddOperation(dependencies);
  const first = context("first");
  const second = context("second");
  const [a, b] = await Promise.all([operation.prepare(first), operation.prepare(second)]);
  await operation.apply(b);
  await operation.apply(a);

  expect(first.storage.put).toHaveBeenCalledExactlyOnceWith("notes", a.nextDoc);
  expect(second.storage.put).toHaveBeenCalledExactlyOnceWith("notes", b.nextDoc);
  expect(a.nextDoc?.id).toBe("first");
  expect(b.nextDoc?.id).toBe("second");
  expect(dependencies.policy.evaluateCollection).toHaveBeenCalledWith(
    definition,
    expect.objectContaining({ actor: "first", nextDoc: a.nextDoc }),
    { conceal: false },
  );
});

test("resolved operation applies with the caller's transaction storage", async () => {
  const input = context("scoped");
  const resolved = await prepareCollection(input, adapters());
  expect(input.storage.put).not.toHaveBeenCalled();
  expect(input.storage.delete).not.toHaveBeenCalled();
  const transactionStorage = storage();
  await expect(resolved.apply(transactionStorage)).resolves.toEqual(
    expect.objectContaining({ id: "scoped" }),
  );
  expect(input.storage.put).not.toHaveBeenCalled();
  expect(transactionStorage.put).toHaveBeenCalledExactlyOnceWith(
    "notes",
    expect.objectContaining({ id: "scoped" }),
  );
});

test("unknown collections fail before document building or authorization", async () => {
  const dependencies = adapters();
  const build = vi.spyOn(dependencies.documents, "buildAdd");
  await expect(
    prepareCollection({ ...context("unknown"), collections: {} }, dependencies),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(build).not.toHaveBeenCalled();
  expect(dependencies.policy.evaluateCollection).not.toHaveBeenCalled();
});

test("set validation errors are concealed when authorization denies access", async () => {
  const dependencies = adapters();
  const invalid = new Error("Invalid input");
  const concealed = new NotFoundError("Document not found");
  dependencies.documents.buildSet = vi.fn(async () => {
    throw invalid;
  });
  dependencies.policy.evaluateCollection = vi.fn(async () => {
    throw concealed;
  });
  const input = context("hidden");
  const request = { ...input, req: { ...input.req, operation: "set" as const } };
  await expect(prepareCollection(request, dependencies)).rejects.toBe(concealed);
  expect(input.storage.put).not.toHaveBeenCalled();
  dependencies.policy.evaluateCollection = vi.fn(async () => fullAccess);
  await expect(prepareCollection(request, dependencies)).rejects.toBe(invalid);
  expect(input.storage.put).not.toHaveBeenCalled();
});
