import { ForbiddenError, NotFoundError } from "./errors";
import { withLoggedSpan, type InternalLogger } from "./logging";
import { collectionSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { allows, denialReasonOf, evaluateAccessPolicy } from "./policy";
import { compileListOptions } from "./query";
import { bindThrowingListAll, LIST_PAGE_MAX } from "./list-all";
import {
  commitAddDoc,
  prepareAddDoc,
  prepareSetDoc,
  prepareUpdateDoc,
  storageAdd,
  storageDelete,
  storageSet,
  storageUpdate,
} from "./typed-storage";
import type {
  AccessContext,
  AccessGrant,
  AccessPermission,
  CollectionApi,
  CollectionDefinition,
  CollectionOperation,
  CollectionsApi,
  CollectionsDef,
  StorageDriver,
  StorageListOptions,
  TrustedCollectionApi,
  TrustedCollectionsApi,
  WithMetadata,
} from "./types";

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

/**
 * Map accessPolicy denial to the public error code.
 * Document-level denials (get / update / delete / set) become NOT_FOUND so
 * IDs are not leaked. Create / list denials stay FORBIDDEN. `set` conceals
 * whether the document already existed.
 */
async function assertAccess(
  def: CollectionDefinition,
  // Executor passes runtime docs; collection-specific TDoc is enforced at definition time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AccessContext TDoc varies
  accessCtx: AccessContext<any, any>,
  options: { conceal: boolean; id?: string },
  logger?: InternalLogger,
): Promise<AccessGrant> {
  return withLoggedSpan(
    logger,
    {
      name: TAKIBI_SPAN.policy,
      kind: "internal",
      attributes: collectionSpanAttributes(accessCtx.collection, accessCtx.operation, options.id),
    },
    {
      event: "takibi.policy",
      collection: accessCtx.collection,
      operation: accessCtx.operation,
      ...(options.id === undefined ? {} : { documentId: options.id }),
      ...(accessCtx.where === undefined ? {} : { query: accessCtx.where }),
    },
    async () => {
      const granted = await evaluateAccessPolicy(def.accessPolicy, accessCtx);
      if (allows(granted, accessCtx.permission)) return granted;
      if (options.conceal) {
        throw new NotFoundError(options.id ? `Document not found: ${options.id}` : "Not found");
      }
      throw new ForbiddenError("Forbidden", denialReasonOf(granted, accessCtx.permission));
    },
  );
}

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
      const granted = await assertAccess(def, accessCtx, { conceal: false }, logger);
      await commitAddDoc(storage, req.collection, nextDoc);
      return writeResult(nextDoc, granted);
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
        await assertAccess(def, accessCtxBase, { conceal: true, id: req.id }, logger);
        throw error;
      }
      const granted = await assertAccess(
        def,
        { ...accessCtxBase, nextDoc },
        { conceal: true, id: req.id },
        logger,
      );
      await storage.put(req.collection, nextDoc);
      return writeResult(nextDoc, granted);
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
      await assertAccess(def, accessCtx, { conceal: true, id: req.id }, logger);
      return doc;
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
        await assertAccess(def, accessCtxBase, { conceal: true, id: req.id }, logger);
        throw error;
      }
      const granted = await assertAccess(
        def,
        { ...accessCtxBase, nextDoc },
        { conceal: true, id: req.id },
        logger,
      );
      await storage.put(req.collection, nextDoc);
      return writeResult(nextDoc, granted);
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
      await assertAccess(def, accessCtx, { conceal: true, id: req.id }, logger);
      return storageDelete(storage, req.collection, req.id);
    }
    case "list": {
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "list",
        permission: "list",
        ...(req.list?.where ? { where: req.list.where } : {}),
      };
      await assertAccess(def, accessCtx, { conceal: false }, logger);
      return storage.list(req.collection, req.list);
    }
    case "count": {
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "count",
        permission: "list",
        ...(req.list?.where ? { where: req.list.where } : {}),
      };
      await assertAccess(def, accessCtx, { conceal: false }, logger);
      return countDocuments(storage, req.collection, req.list);
    }
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
): CollectionsApi<TCollections> {
  const api = Object.create(null) as CollectionsApi<TCollections>;
  for (const name of Object.keys(collections) as (keyof TCollections & string)[]) {
    const collectionApi = {
      add: (input, options) =>
        executeOperation(
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
        ),
      set: (id, input) =>
        executeOperation(
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
        ),
      get: (id) =>
        executeOperation(
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
        ),
      update: (id, input) =>
        executeOperation(
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
        ),
      delete: (id) =>
        executeOperation(
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
        ),
      list: (list) =>
        executeOperation(
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
        ),
      count: (list) =>
        executeOperation(
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
  transactionBound = false,
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
        return runTrustedMutation(storage, transactionBound, async (scoped) => {
          const targets = await collectDocuments(scoped, name, compiled);
          for (const target of targets) {
            await updateTrustedDocument(definition, scoped, name, target, input, logger);
          }
          return { updated: targets.length };
        });
      },
      async deleteMany(options) {
        const compiled = compileConditionalWriteOptions(options);
        return runTrustedMutation(storage, transactionBound, async (scoped) => {
          const targets = await collectDocuments(scoped, name, compiled);
          for (const target of targets) {
            await storageDelete(scoped, name, target.id);
          }
          return { deleted: targets.length };
        });
      },
      async consumeOne(options) {
        const compiled = compileConditionalWriteOptions(options);
        return runTrustedMutation(storage, transactionBound, async (scoped) => {
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
        return runTrustedMutation(storage, transactionBound, async (scoped) => {
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
    transactionBound
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
  transactionBound: boolean,
  callback: (storage: StorageDriver) => Promise<T>,
): Promise<T> {
  return transactionBound ? callback(storage) : storage.transaction(callback);
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
