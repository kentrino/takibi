import { ForbiddenError, NotFoundError } from "./errors";
import { TAKIBI_ATTR } from "./otel-span";
import { allows, evaluateAccessPolicy } from "./policy";
import { compileListOptions } from "./query";
import { withSpan } from "./tracing";
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
  AccessPermission,
  CollectionApi,
  CollectionDefinition,
  CollectionOperation,
  CollectionsApi,
  CollectionsDef,
  StorageDriver,
  StorageListOptions,
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
): Promise<void> {
  await withSpan(
    {
      name: "takibi.policy",
      kind: "internal",
      attributes: {
        [TAKIBI_ATTR.collection.name]: accessCtx.collection,
        [TAKIBI_ATTR.operation.name]: accessCtx.operation,
        ...(options.id === undefined ? {} : { [TAKIBI_ATTR.document.id]: options.id }),
      },
    },
    async () => {
      const granted = await evaluateAccessPolicy(def.accessPolicy, accessCtx);
      if (allows(granted, accessCtx.permission)) return;
      if (options.conceal) {
        throw new NotFoundError(options.id ? `Document not found: ${options.id}` : "Not found");
      }
      throw new ForbiddenError();
    },
  );
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
): Promise<unknown> {
  const def = collections[req.collection] as CollectionDefinition | undefined;
  if (!def) {
    throw new NotFoundError(`Unknown collection: ${req.collection}`);
  }

  switch (req.operation) {
    case "add": {
      const nextDoc = await prepareAddDoc(def, req.input, { id: req.id });
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "add",
        permission: "create",
        nextDoc,
      };
      await assertAccess(def, accessCtx, { conceal: false });
      return commitAddDoc(storage, req.collection, nextDoc);
    }
    case "set": {
      if (!req.id) throw new NotFoundError("Missing id");
      const existing = await storage.get(req.collection, req.id);
      const nextDoc = await prepareSetDoc(def, req.id, req.input, existing);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "set",
        permission: resolvePermission("set", existing),
        ...(existing ? { doc: existing } : {}),
        nextDoc,
      };
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
      await storage.put(req.collection, nextDoc);
      return nextDoc;
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
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
      return doc;
    }
    case "update": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.collection, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const nextDoc = await prepareUpdateDoc(def, req.id, req.input, doc);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        collection: req.collection,
        operation: "update",
        permission: "update",
        doc,
        nextDoc,
      };
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
      await storage.put(req.collection, nextDoc);
      return nextDoc;
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
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
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
      await assertAccess(def, accessCtx, { conceal: false });
      return storage.list(req.collection, req.list);
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
>(collections: TCollections, storage: StorageDriver, ctx: TCtx): CollectionsApi<TCollections> {
  const api = Object.create(null) as CollectionsApi<TCollections>;
  for (const name of Object.keys(collections) as (keyof TCollections & string)[]) {
    api[name] = {
      add: (input, options) =>
        executeOperation(collections, storage, ctx, {
          kind: "collection",
          collection: name,
          operation: "add",
          input,
          ...(options?.id !== undefined ? { id: options.id } : {}),
        }),
      set: (id, input) =>
        executeOperation(collections, storage, ctx, {
          kind: "collection",
          collection: name,
          operation: "set",
          id,
          input,
        }),
      get: (id) =>
        executeOperation(collections, storage, ctx, {
          kind: "collection",
          collection: name,
          operation: "get",
          id,
        }),
      update: (id, input) =>
        executeOperation(collections, storage, ctx, {
          kind: "collection",
          collection: name,
          operation: "update",
          id,
          input,
        }),
      delete: (id) =>
        executeOperation(collections, storage, ctx, {
          kind: "collection",
          collection: name,
          operation: "delete",
          id,
        }),
      list: (list) =>
        executeOperation(collections, storage, ctx, {
          kind: "collection",
          collection: name,
          operation: "list",
          ...(list ? { list: compileListOptions(list) } : {}),
        }),
    } as CollectionApi<TCollections[typeof name]>;
  }
  return api;
}

export function createTrustedCollections<TCollections extends CollectionsDef>(
  collections: TCollections,
  storage: StorageDriver,
): CollectionsApi<TCollections> {
  const api = Object.create(null) as CollectionsApi<TCollections>;
  for (const name of Object.keys(collections) as (keyof TCollections & string)[]) {
    const definition = collections[name]!;
    api[name] = {
      add: (input, options) => storageAdd(definition, storage, name, input, options),
      set: (id, input) => storageSet(definition, storage, name, id, input),
      async get(id) {
        const doc = await storage.get(name, id);
        if (!doc) throw new NotFoundError(`Document not found: ${id}`);
        return doc;
      },
      update: (id, input) => storageUpdate(definition, storage, name, id, input),
      delete: (id) => storageDelete(storage, name, id),
      list: (options) => storage.list(name, compileListOptions(options)),
    } as CollectionApi<TCollections[typeof name]>;
  }
  return api;
}
