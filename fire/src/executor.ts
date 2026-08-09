import { ForbiddenError, NotFoundError } from "./errors";
import { allows, CREATE, DELETE, READ, UPDATE, type Permission } from "./permissions";
import { storageAdd, storageDelete, storageSet, storageUpdate } from "./typed-storage";
import type {
  AccessContext,
  ResourceDefinition,
  ResourceOperation,
  ResourcesDef,
  StorageDriver,
} from "./types";

export type ExecuteRequest = {
  resource: string;
  operation: ResourceOperation;
  id?: string;
  input?: unknown;
  list?: { limit?: number; cursor?: string };
};

const OP_PERMISSION: Record<ResourceOperation, Permission> = {
  add: CREATE,
  set: UPDATE,
  get: READ,
  list: READ,
  update: UPDATE,
  delete: DELETE,
};

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

  const accessCtx: AccessContext<TCtx> = {
    ...ctx,
    resource: req.resource,
    operation: req.operation,
  };
  const grant = await def.accessControl(accessCtx);

  // `set` may create or overwrite — allow CREATE or UPDATE
  if (req.operation === "set") {
    if (!allows(grant, CREATE) && !allows(grant, UPDATE)) {
      throw new ForbiddenError(`Missing permission for ${req.resource}.set`);
    }
  } else if (!allows(grant, OP_PERMISSION[req.operation])) {
    throw new ForbiddenError(`Missing permission for ${req.resource}.${req.operation}`);
  }

  switch (req.operation) {
    case "add":
      return storageAdd(def, storage, req.resource, req.input);
    case "set":
      if (!req.id) throw new NotFoundError("Missing id");
      return storageSet(def, storage, req.resource, req.id, req.input);
    case "get": {
      if (!req.id) throw new NotFoundError("Missing id");
      return storage.get(req.resource, req.id);
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
