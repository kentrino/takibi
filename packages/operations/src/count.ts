import type { AccessContext } from "@takibi/policy";
import type {
  OperationAdapters,
  OperationContext,
  OperationState,
  CollectionOperationHandler,
} from "./types";
import { LIST_PAGE_MAX } from "@takibi/api";
import type { StorageListOptions } from "@takibi/shared-types";
import type { StorageDriver } from "@takibi/storage";

export class CountOperation implements CollectionOperationHandler {
  readonly #adapters: OperationAdapters;

  constructor(adapters: OperationAdapters) {
    this.#adapters = adapters;
  }

  async prepare<TCtx extends object>(args: OperationContext<TCtx>): Promise<OperationState<TCtx>> {
    const { collections, storage, ctx, req, def } = args;
    const { policy } = this.#adapters;
    const accessCtx: AccessContext<TCtx> = {
      ...ctx,
      collection: req.collection,
      operation: "count",
      permission: "list",
      ...(req.list?.where ? { where: req.list.where } : {}),
    };
    const grant = await policy.evaluateCollection(def, accessCtx, { conceal: false });
    return { req, ctx, def, collections, storage, grant };
  }

  async apply<TCtx extends object>(resolved: OperationState<TCtx>) {
    const { req, storage } = resolved;
    return countDocuments(storage, req.collection, req.list);
  }
}

export async function countDocuments(
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
