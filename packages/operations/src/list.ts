import type { AccessContext } from "@takibi/policy";
import type {
  OperationAdapters,
  OperationContext,
  OperationState,
  CollectionOperationHandler,
} from "./types";

export class ListOperation implements CollectionOperationHandler {
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
      operation: "list",
      permission: "list",
      ...(req.list?.where ? { where: req.list.where } : {}),
    };
    const grant = await policy.evaluateCollection(def, accessCtx, { conceal: false });
    return { req, ctx, def, collections, storage, grant };
  }

  async apply<TCtx extends object>(resolved: OperationState<TCtx>) {
    const { req, storage } = resolved;
    return storage.list(req.collection, req.list);
  }
}
