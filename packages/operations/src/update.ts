import type { AccessContext } from "@takibi/policy";
import type {
  OperationAdapters,
  OperationContext,
  OperationState,
  CollectionOperationHandler,
} from "./types";
import { NotFoundError } from "@takibi/api";
import type { WithMetadata } from "@takibi/shared-types";
import { writeResult } from "./write-result";

export class UpdateOperation implements CollectionOperationHandler {
  readonly #adapters: OperationAdapters;

  constructor(adapters: OperationAdapters) {
    this.#adapters = adapters;
  }

  async prepare<TCtx extends object>(args: OperationContext<TCtx>): Promise<OperationState<TCtx>> {
    const { collections, storage, ctx, req, def } = args;
    const { policy, documents } = this.#adapters;
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
      nextDoc = await documents.buildUpdate(def, req.id, req.input, doc);
    } catch (error) {
      await policy.evaluateCollection(def, accessCtxBase, { conceal: true, id: req.id });
      throw error;
    }
    const grant = await policy.evaluateCollection(
      def,
      { ...accessCtxBase, nextDoc },
      { conceal: true, id: req.id },
    );
    return { req, ctx, def, collections, storage, grant, existing: doc, nextDoc };
  }

  async apply<TCtx extends object>(resolved: OperationState<TCtx>) {
    const { req, storage, grant, nextDoc } = resolved;
    await storage.put(req.collection, nextDoc!);
    return writeResult(nextDoc!, grant);
  }
}
