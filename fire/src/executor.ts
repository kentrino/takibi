import { ForbiddenError, NotFoundError } from "./errors";
import { allows, evaluateAccessPolicy } from "./policy";
import {
  commitAddDoc,
  prepareAddDoc,
  prepareSetDoc,
  prepareUpdateDoc,
  storageDelete,
} from "./typed-storage";
import type {
  AccessAction,
  AccessContext,
  ResourceDefinition,
  ResourceOperation,
  ResourcesDef,
  StorageDriver,
  WithMetadata,
} from "./types";

export type ExecuteRequest = {
  resource: string;
  operation: ResourceOperation;
  id?: string;
  input?: unknown;
  list?: { limit?: number; cursor?: string };
};

function resolveAction(
  operation: ResourceOperation,
  existing: WithMetadata<Record<string, unknown>> | null | undefined,
): AccessAction {
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
 * Document-level denials (existing get / update / delete / set) become NOT_FOUND
 * so IDs are not leaked. Create / new set / list denials stay FORBIDDEN.
 */
async function assertAccess(
  def: ResourceDefinition,
  // Executor passes runtime docs; resource-specific TDoc is enforced at definition time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AccessContext TDoc varies per resource
  accessCtx: AccessContext<any, any>,
  options: { conceal: boolean; id?: string },
): Promise<void> {
  const granted = await evaluateAccessPolicy(def.accessPolicy, accessCtx);
  if (allows(granted, accessCtx.action)) return;
  if (options.conceal) {
    throw new NotFoundError(options.id ? `Document not found: ${options.id}` : "Not found");
  }
  throw new ForbiddenError();
}

export async function executeOperation<TCtx extends { tenantId: string; user: unknown }>(
  resources: ResourcesDef<TCtx>,
  storage: StorageDriver,
  ctx: TCtx,
  req: ExecuteRequest,
): Promise<unknown> {
  const def = resources[req.resource] as ResourceDefinition | undefined;
  if (!def) {
    throw new NotFoundError(`Unknown resource: ${req.resource}`);
  }

  switch (req.operation) {
    case "add": {
      const nextDoc = await prepareAddDoc(def, req.input, { id: req.id });
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        resource: req.resource,
        operation: "add",
        action: "create",
        nextDoc,
      };
      await assertAccess(def, accessCtx, { conceal: false });
      return commitAddDoc(storage, req.resource, nextDoc);
    }
    case "set": {
      if (!req.id) throw new NotFoundError("Missing id");
      const existing = await storage.get(req.resource, req.id);
      const nextDoc = await prepareSetDoc(def, req.id, req.input, existing);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        resource: req.resource,
        operation: "set",
        action: resolveAction("set", existing),
        ...(existing ? { doc: existing } : {}),
        nextDoc,
      };
      await assertAccess(def, accessCtx, {
        conceal: existing != null,
        id: req.id,
      });
      await storage.put(req.resource, nextDoc);
      return nextDoc;
    }
    case "get": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.resource, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        resource: req.resource,
        operation: "get",
        action: "get",
        doc,
      };
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
      return doc;
    }
    case "update": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.resource, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const nextDoc = await prepareUpdateDoc(def, req.id, req.input, doc);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        resource: req.resource,
        operation: "update",
        action: "update",
        doc,
        nextDoc,
      };
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
      await storage.put(req.resource, nextDoc);
      return nextDoc;
    }
    case "delete": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.resource, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        resource: req.resource,
        operation: "delete",
        action: "delete",
        doc,
      };
      await assertAccess(def, accessCtx, { conceal: true, id: req.id });
      return storageDelete(storage, req.resource, req.id);
    }
    case "list": {
      const accessCtx: AccessContext<TCtx> = {
        ...ctx,
        resource: req.resource,
        operation: "list",
        action: "list",
      };
      await assertAccess(def, accessCtx, { conceal: false });
      return storage.list(req.resource, req.list);
    }
    default: {
      const _exhaustive: never = req.operation;
      return _exhaustive;
    }
  }
}
