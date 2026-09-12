import type { AccessContext } from "@takibi/policy";
import type {
  OperationAdapters,
  OperationContext,
  OperationState,
  CollectionOperationHandler,
} from "./types";
import { NotFoundError } from "@takibi/api";

export class GetOperation implements CollectionOperationHandler {
  readonly #adapters: OperationAdapters;

  constructor(adapters: OperationAdapters) {
    this.#adapters = adapters;
  }

  async prepare<TCtx extends object>(args: OperationContext<TCtx>): Promise<OperationState<TCtx>> {
    const { collections, storage, ctx, req, def } = args;
    const { policy } = this.#adapters;
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
    return { req, ctx, def, collections, storage, grant, existing: doc };
  }

  async apply<TCtx extends object>(resolved: OperationState<TCtx>) {
    return resolved.existing;
  }
}
