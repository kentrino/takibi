import { AlreadyExistsError } from "@takibi/api";
import type { StorageDriver } from "@takibi/storage";
import type { WithMetadata } from "@takibi/shared-types";
import type { AccessContext } from "@takibi/policy";
import type {
  OperationAdapters,
  OperationContext,
  OperationState,
  CollectionOperationHandler,
} from "./types";
import { writeResult } from "./write-result";

export class AddOperation implements CollectionOperationHandler {
  readonly #adapters: OperationAdapters;

  constructor(adapters: OperationAdapters) {
    this.#adapters = adapters;
  }

  async prepare<TCtx extends object>(args: OperationContext<TCtx>): Promise<OperationState<TCtx>> {
    const { collections, storage, ctx, req, def } = args;
    const { policy, documents } = this.#adapters;
    const nextDoc = await documents.buildAdd(def, req.input, { id: req.id });
    const accessCtx: AccessContext<TCtx> = {
      ...ctx,
      collection: req.collection,
      operation: "add",
      permission: "create",
      nextDoc,
    };
    const grant = await policy.evaluateCollection(def, accessCtx, { conceal: false });
    return { req, ctx, def, collections, storage, grant, nextDoc };
  }

  async apply<TCtx extends object>(resolved: OperationState<TCtx>) {
    const { req, storage, grant, nextDoc } = resolved;
    await persistAddDoc(storage, req.collection, nextDoc!);
    return writeResult(nextDoc!, grant);
  }
}

/** CREATE-only put: rejects when `doc.id` already exists. */
export async function persistAddDoc(
  storage: StorageDriver,
  collection: string,
  doc: WithMetadata<Record<string, unknown>>,
): Promise<WithMetadata<Record<string, unknown>>> {
  const existing = await storage.get(collection, doc.id);
  if (existing) {
    throw new AlreadyExistsError(`Document already exists: ${doc.id}`);
  }
  await storage.put(collection, doc);
  return doc;
}
