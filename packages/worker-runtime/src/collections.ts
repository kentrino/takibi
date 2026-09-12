import { compileListOptions, type ListOptions } from "@takibi/query";
import {
  NotFoundError,
  bindThrowingListAll,
  LIST_PAGE_MAX,
  type CollectionApi,
  type CollectionDefinition,
  type CollectionsApi,
  type CollectionsDef,
  type ConditionalWriteOptions,
  type TrustedCollectionApi,
  type TrustedCollectionsApi,
} from "@takibi/api";
import type { StorageListOptions, WithMetadata } from "@takibi/shared-types";
import type { StorageDriver } from "@takibi/storage";
import type { InternalLogger } from "./logging";
import { executeOperationInScope } from "./executor";
import {
  prepareUpdateDoc,
  storageAdd,
  storageSet,
  storageUpdate,
  storageDelete,
} from "./typed-storage";

export function createPolicyCollections<
  TCtx extends object,
  TCollections extends CollectionsDef<TCtx>,
>(
  collections: TCollections,
  storage: StorageDriver,
  ctx: TCtx,
  logger?: InternalLogger,
  reuseTransaction = false,
): CollectionsApi<TCollections> {
  const api = Object.create(null) as CollectionsApi<TCollections>;
  for (const name of Object.keys(collections) as (keyof TCollections & string)[]) {
    const collectionApi = {
      add: (input, options) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "add",
            input,
            ...(options?.id !== undefined ? { id: options.id } : {}),
          },
          logger,
          reuseTransaction,
        ),
      set: (id, input) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "set",
            id,
            input,
          },
          logger,
          reuseTransaction,
        ),
      get: (id) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "get",
            id,
          },
          logger,
          reuseTransaction,
        ),
      update: (id, input) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "update",
            id,
            input,
          },
          logger,
          reuseTransaction,
        ),
      delete: (id) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "delete",
            id,
          },
          logger,
          reuseTransaction,
        ),
      list: (list) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "list",
            ...(list ? { list: compileListOptions(list) } : {}),
          },
          logger,
          reuseTransaction,
        ),
      count: (list) =>
        executeOperationInScope(
          collections,
          storage,
          ctx,
          {
            kind: "collection",
            collection: name,
            operation: "count",
            ...(list ? { list: compileListOptions(list) } : {}),
          },
          logger,
          reuseTransaction,
        ),
    } as CollectionApi<TCollections[typeof name]>;
    collectionApi.listAll = bindThrowingListAll(collectionApi.list);
    api[name] = collectionApi;
  }
  return api;
}

export function createTrustedCollections<TCollections extends CollectionsDef>(
  collections: TCollections,
  storage: StorageDriver,
  logger?: InternalLogger,
  reuseTransaction = false,
): TrustedCollectionsApi<TCollections> {
  const api = Object.create(null) as {
    [K in Exclude<keyof TCollections, "$transaction">]: TrustedCollectionApi<TCollections[K]>;
  };
  for (const name of Object.keys(collections) as (Exclude<keyof TCollections, "$transaction"> &
    string)[]) {
    const definition = collections[name]!;
    const collectionApi = {
      add: (input, options) => storageAdd(definition, storage, name, input, options, logger),
      set: (id, input) => storageSet(definition, storage, name, id, input, undefined, logger),
      async get(id) {
        const doc = await storage.get(name, id);
        if (!doc) throw new NotFoundError(`Document not found: ${id}`);
        return doc;
      },
      update: (id, input) => storageUpdate(definition, storage, name, id, input, logger),
      delete: (id) => storageDelete(storage, name, id),
      list: (options) => storage.list(name, compileListOptions(options)),
      count: (options) => countDocuments(storage, name, compileListOptions(options)),
      async updateMany(input, options) {
        const compiled = compileConditionalWriteOptions(options);
        return runTrustedMutation(storage, reuseTransaction, async (scoped) => {
          const targets = await collectDocuments(scoped, name, compiled);
          for (const target of targets) {
            await updateTrustedDocument(definition, scoped, name, target, input, logger);
          }
          return { updated: targets.length };
        });
      },
      async deleteMany(options) {
        const compiled = compileConditionalWriteOptions(options);
        return runTrustedMutation(storage, reuseTransaction, async (scoped) => {
          const targets = await collectDocuments(scoped, name, compiled);
          for (const target of targets) {
            await storageDelete(scoped, name, target.id);
          }
          return { deleted: targets.length };
        });
      },
      async consumeOne(options) {
        const compiled = compileConditionalWriteOptions(options);
        return runTrustedMutation(storage, reuseTransaction, async (scoped) => {
          const page = await scoped.list(name, { ...compiled, limit: 1 });
          const target = page.items[0];
          if (!target) return null;
          await storageDelete(scoped, name, target.id);
          return target;
        });
      },
      async incrementOne(increment, options) {
        const entries = normalizeIncrement(increment);
        const compiled = compileConditionalWriteOptions(options);
        return runTrustedMutation(storage, reuseTransaction, async (scoped) => {
          const page = await scoped.list(name, { ...compiled, limit: 1 });
          const target = page.items[0];
          if (!target) return null;
          const incremented = Object.fromEntries(
            entries.map(([field, delta]) => [
              field,
              (typeof target[field] === "number" ? target[field] : 0) + delta,
            ]),
          );
          return updateTrustedDocument(
            definition,
            scoped,
            name,
            target,
            { ...incremented, ...options.set },
            logger,
          );
        });
      },
    } as TrustedCollectionApi<TCollections[typeof name]>;
    collectionApi.listAll = bindThrowingListAll(collectionApi.list);
    api[name] = collectionApi;
  }
  const trustedApi = Object.assign(api, {
    $transaction<T>(
      callback: ($collections: TrustedCollectionsApi<TCollections>) => Promise<T>,
    ): Promise<T> {
      return reuseTransaction
        ? callback(trustedApi)
        : storage.transaction((scoped) =>
            callback(createTrustedCollections(collections, scoped, logger, true)),
          );
    },
  });
  return trustedApi;
}

async function collectDocuments(
  storage: StorageDriver,
  collection: string,
  options: StorageListOptions,
): Promise<WithMetadata<Record<string, unknown>>[]> {
  const documents: WithMetadata<Record<string, unknown>>[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.list(collection, {
      ...options,
      limit: LIST_PAGE_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    documents.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return documents;
}

function compileConditionalWriteOptions<TDoc, TIndexes extends Record<string, readonly string[]>>(
  options: ConditionalWriteOptions<TDoc, TIndexes> & ListOptions<TDoc, TIndexes>,
): StorageListOptions & { where: NonNullable<StorageListOptions["where"]> } {
  const compiled = compileListOptions(options);
  if (!compiled?.where) {
    throw new TypeError("Conditional writes require where");
  }
  return { ...compiled, where: compiled.where };
}

function runTrustedMutation<T>(
  storage: StorageDriver,
  reuseTransaction: boolean,
  callback: (storage: StorageDriver) => Promise<T>,
): Promise<T> {
  return reuseTransaction ? callback(storage) : storage.transaction(callback);
}

function normalizeIncrement(value: unknown): [string, number][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("increment must be an object");
  }
  return Object.entries(value).map(([field, delta]) => {
    if (field.length === 0 || typeof delta !== "number" || !Number.isFinite(delta)) {
      throw new TypeError("increment values must be finite numbers");
    }
    return [field, delta];
  });
}

async function updateTrustedDocument(
  definition: CollectionDefinition,
  storage: StorageDriver,
  collection: string,
  existing: WithMetadata<Record<string, unknown>>,
  input: unknown,
  logger?: InternalLogger,
): Promise<WithMetadata<Record<string, unknown>>> {
  const document = await prepareUpdateDoc(definition, existing.id, input, existing, logger);
  await storage.put(collection, document);
  return document;
}

async function countDocuments(
  storage: StorageDriver,
  collection: string,
  options: StorageListOptions | undefined,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await storage.list(collection, {
      ...options,
      limit: LIST_PAGE_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    count += page.items.length;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return count;
}
