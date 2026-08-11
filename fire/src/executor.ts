import { ForbiddenError, NotFoundError } from "./errors";
import { storageAdd, storageDelete, storageSet, storageUpdate } from "./typed-storage";
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

  let existingForSet: WithMetadata<Record<string, unknown>> | null | undefined;
  if (req.operation === "set") {
    if (!req.id) throw new NotFoundError("Missing id");
    existingForSet = await storage.get(req.resource, req.id);
  }

  const action = resolveAction(req.operation, existingForSet);
  const accessCtx: AccessContext<TCtx> = {
    ...ctx,
    resource: req.resource,
    operation: req.operation,
    action,
  };
  const allowed = await def.accessPolicy(accessCtx);
  if (!allowed) {
    throw new ForbiddenError();
  }

  switch (req.operation) {
    case "add":
      return storageAdd(def, storage, req.resource, req.input, { id: req.id });
    case "set":
      if (!req.id) throw new NotFoundError("Missing id");
      return storageSet(def, storage, req.resource, req.id, req.input, {
        existing: existingForSet ?? null,
      });
    case "get": {
      if (!req.id) throw new NotFoundError("Missing id");
      const doc = await storage.get(req.resource, req.id);
      if (!doc) throw new NotFoundError(`Document not found: ${req.id}`);
      return doc;
    }
    case "update": {
      if (!req.id) throw new NotFoundError("Missing id");
      return storageUpdate(def, storage, req.resource, req.id, req.input);
    }
    case "delete": {
      if (!req.id) throw new NotFoundError("Missing id");
      return storageDelete(storage, req.resource, req.id);
    }
    case "list":
      return storage.list(req.resource, req.list);
    default: {
      const _exhaustive: never = req.operation;
      return _exhaustive;
    }
  }
}
