import {
  allows,
  type AccessContext,
  type AccessGrant,
  type AccessPermission,
  type CollectionOperation,
} from "@takibi/takibi-policy";
import { compileListOptions } from "@takibi/takibi-query";
import {
  NotFoundError,
  bindThrowingListAll,
  LIST_PAGE_MAX,
  type CollectionApi,
  type CollectionDefinition,
  type CollectionsApi,
  type CollectionsDef,
  type TrustedCollectionApi,
  type TrustedCollectionsApi,
} from "@takibi/takibi-api";
import type { StorageListOptions, WithMetadata } from "@takibi/takibi-shared-types";
import { executePlan } from "@takibi/takibi-worker-runtime-contract";
import { createInvocationCollaborators, type PolicySurface } from "./invocation-collaborators";
import type { InternalLogger } from "./logging";
import {
  persistAddDoc,
  prepareAddDoc,
  prepareSetDoc,
  prepareUpdateDoc,
  storageAdd,
  storageDelete,
  storageSet,
  storageUpdate,
} from "./typed-storage";
import type { StorageDriver } from "@takibi/takibi-storage";
import { collectionExecutionPlan } from "./transaction-boundary";
import type { TakibiCollectionWork } from "./invocation-type-map";

export type ExecuteRequest = {
  kind: "collection";
  collection: string;
  operation: CollectionOperation;
  id?: string;
  input?: unknown;
  list?: StorageListOptions;
};

function resolvePermission(
  operation: CollectionOperation,
  existing: WithMetadata<Record<string, unknown>> | null | undefined,
): Exclude<AccessPermission, "invoke"> {
  switch (operation) {
    case "add":
      return "create";
    case "get":
      return "get";
    case "list":
    case "count":
      return "list";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "set":
      return existing == null ? "create" : "update";
    default: {
      const _exhaustive: never = operation;
      return _exhaustive;
    }
  }
}

export type ResolvedCollection<TCtx extends object> = {
  readonly req: ExecuteRequest;
  readonly ctx: TCtx;
  readonly def: CollectionDefinition;
  readonly collections: CollectionsDef<TCtx>;
  readonly storage: StorageDriver;
  readonly logger?: InternalLogger;
  readonly grant: AccessGrant;
  readonly existing?: WithMetadata<Record<string, unknown>> | null;
  readonly nextDoc?: WithMetadata<Record<string, unknown>>;
};

/** Writes collate `update`/`create`. The stored document is only returned when the same grant includes `get`. */
function writeResult(doc: WithMetadata<Record<string, unknown>>, granted: AccessGrant): unknown {
  if (allows(granted, "get")) return doc;
  return { id: doc.id, updatedAt: doc.updatedAt, rev: doc.rev };
}

/**
 * Run a collection operation. The envelope must already be a valid
 * `ExecuteRequest` from `decodeWireRequest` (or an equivalent trusted
 * constructor). This function does not re-check wire shape.
 */
export async function executeOperation<TCtx extends object>(
  collections: CollectionsDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  req: ExecuteRequest,
  logger?: InternalLogger,
): Promise<unknown> {
  return executeOperationInScope(collections, storage, ctx, req, logger, false);
}

async function executeOperationInScope<TCtx extends object>(
  collections: CollectionsDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  req: ExecuteRequest,
  logger: InternalLogger | undefined,
  reuseTransaction: boolean,
): Promise<unknown> {
  const { policy } = createInvocationCollaborators({
    logger,
    collection: req.collection,
    operation: req.operation,
    documentId: req.id,
  });
  const work: TakibiCollectionWork = {
    kind: "collection",
    operation: {
      kind: "collection",
      collection: req.collection,
      operation: req.operation,
    },
    capability:
      req.operation === "get" || req.operation === "list" || req.operation === "count"
        ? "read-only"
        : "writes",
    request: req,
  };
  const plan = collectionExecutionPlan(work);
  const prepare = (_work: TakibiCollectionWork, scopedStorage: StorageDriver) =>
    resolveCollection({
      collections,
      storage: scopedStorage,
      ctx,
      req,
      logger,
      policy,
    });
  const apply = (resolved: ResolvedCollection<TCtx>, scopedStorage: StorageDriver) =>
    executeResolvedCollection({ ...resolved, storage: scopedStorage });
  return executePlan({
    plan,
    storage,
    reuseTransaction,
    runInTransaction: (callback) =>
      storage.transaction(async (scopedStorage) => callback(scopedStorage)),
    none: { prepare, apply },
    apply: { prepare, apply },
    full: {
      prepareAndApply: async (_work, scopedStorage) =>
        apply(await prepare(work, scopedStorage), scopedStorage),
    },
  });
}

export async function resolveCollection<TCtx extends object>(args: {
  collections: CollectionsDef<TCtx>;
  storage: StorageDriver;
  ctx: TCtx;
  req: ExecuteRequest;
  logger?: InternalLogger;
  policy: PolicySurface;
}): Promise<ResolvedCollection<TCtx>> {
  const { collections, storage, ctx, req, logger, policy } = args;
  const def = collections[req.collection] as CollectionDefinition | undefined;
  if (!def) {
    throw new NotFoundError(`Unknown collection: ${req.collection}`);
  }

  switch (req.operation) {
    case "add": {
      const nextDoc = await prepareAddDoc(def, req.input, { id: req.id }, logger);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "add",
        permission: "create",
        nextDoc,
      };
      const grant = await policy.evaluateCollection(def, accessCtx, { conceal: false });
      return { req, ctx, def, collections, storage, logger, grant, nextDoc };
    }
    case "set": {
      if (!req.id) throw new NotFoundError("Missing id");
      const existing = await storage.get(req.collection, req.id);
      const accessCtxBase: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "set",
        permission: resolvePermission("set", existing),
        ...(existing ? { doc: existing } : {}),
      };
      let nextDoc: WithMetadata<Record<string, unknown>>;
      try {
        nextDoc = await prepareSetDoc(def, req.id, req.input, existing, logger);
      } catch (error) {
        await policy.evaluateCollection(def, accessCtxBase, { conceal: true, id: req.id });
        throw error;
      }
      const grant = await policy.evaluateCollection(
        def,
        { ...accessCtxBase, nextDoc },
        { conceal: true, id: req.id },
      );
      return { req, ctx, def, collections, storage, logger, grant, existing, nextDoc };
    }
    case "get": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.collection, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "get",
        permission: "get",
        doc,
      };
      const grant = await policy.evaluateCollection(def, accessCtx, {
        conceal: true,
        id: req.id,
      });
      return { req, ctx, def, collections, storage, logger, grant, existing: doc };
    }
    case "update": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.collection, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const accessCtxBase: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "update",
        permission: "update",
        doc,
      };
      let nextDoc: WithMetadata<Record<string, unknown>>;
      try {
        nextDoc = await prepareUpdateDoc(def, req.id, req.input, doc, logger);
      } catch (error) {
        await policy.evaluateCollection(def, accessCtxBase, { conceal: true, id: req.id });
        throw error;
      }
      const grant = await policy.evaluateCollection(
        def,
        { ...accessCtxBase, nextDoc },
        { conceal: true, id: req.id },
      );
      return { req, ctx, def, collections, storage, logger, grant, existing: doc, nextDoc };
    }
    case "delete": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.collection, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "delete",
        permission: "delete",
        doc,
      };
      const grant = await policy.evaluateCollection(def, accessCtx, {
        conceal: true,
        id: req.id,
      });
      return { req, ctx, def, collections, storage, logger, grant, existing: doc };
    }
    case "list": {
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "list",
        permission: "list",
        ...(req.list?.where ? { where: req.list.where } : {}),
      };
      const grant = await policy.evaluateCollection(def, accessCtx, { conceal: false });
      return { req, ctx, def, collections, storage, logger, grant };
    }
    case "count": {
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "count",
        permission: "list",
        ...(req.list?.where ? { where: req.list.where } : {}),
      };
      const grant = await policy.evaluateCollection(def, accessCtx, { conceal: false });
      return { req, ctx, def, collections, storage, logger, grant };
    }
    default: {
      const _exhaustive: never = req.operation;
      return _exhaustive;
    }
  }
}

export async function executeResolvedCollection<TCtx extends object>(
  resolved: ResolvedCollection<TCtx>,
): Promise<unknown> {
  const { req, storage, grant, nextDoc } = resolved;
  switch (req.operation) {
    case "add":
      await persistAddDoc(storage, req.collection, nextDoc!);
      return writeResult(nextDoc!, grant);
    case "set":
    case "update":
      await storage.put(req.collection, nextDoc!);
      return writeResult(nextDoc!, grant);
    case "get":
      return resolved.existing;
    case "delete":
      return storageDelete(storage, req.collection, req.id!);
    case "list":
      return storage.list(req.collection, req.list);
    case "count":
      return countDocuments(storage, req.collection, req.list);
    default: {
      const _exhaustive: never = req.operation;
      return _exhaustive;
    }
  }
}

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
  const api = Object.create(null) as TrustedCollectionsApi<TCollections>;
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
    (api as unknown as Record<string, unknown>)[name] = collectionApi;
  }
  api.$transaction = <T>(
    callback: ($collections: TrustedCollectionsApi<TCollections>) => Promise<T>,
  ): Promise<T> =>
    reuseTransaction
      ? callback(api)
      : storage.transaction((scoped) =>
          callback(createTrustedCollections(collections, scoped, logger, true)),
        );
  return api;
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

function compileConditionalWriteOptions(options: unknown): StorageListOptions {
  const compiled = compileListOptions(options as never);
  if (!compiled?.where) {
    throw new TypeError("Conditional writes require where");
  }
  return compiled;
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
