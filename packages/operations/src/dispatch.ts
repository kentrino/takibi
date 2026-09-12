import { NotFoundError } from "@takibi/api";
import type { CollectionOperation } from "@takibi/policy";
import type { StorageDriver } from "@takibi/storage";
import { AddOperation } from "./add";
import { SetOperation } from "./set";
import { GetOperation } from "./get";
import { UpdateOperation } from "./update";
import { DeleteOperation } from "./delete";
import { ListOperation } from "./list";
import { CountOperation } from "./count";
import type {
  CollectionOperationHandler,
  OperationAdapters,
  OperationContext,
  OperationState,
} from "./types";

// Each operation owns validation, authorization, execution, and result visibility.
// Transaction selection and storage scope belong to the invocation executor.
const operations = {
  add: AddOperation,
  set: SetOperation,
  get: GetOperation,
  update: UpdateOperation,
  delete: DeleteOperation,
  list: ListOperation,
  count: CountOperation,
} satisfies Record<
  CollectionOperation,
  new (adapters: OperationAdapters) => CollectionOperationHandler
>;

/** Opaque prepared work; only the storage scope is supplied by the caller. */
export class PreparedCollection<TCtx extends object> {
  readonly #operation: CollectionOperationHandler;
  readonly #state: OperationState<TCtx>;
  private constructor(operation: CollectionOperationHandler, state: OperationState<TCtx>) {
    this.#operation = operation;
    this.#state = state;
  }
  apply(storage: StorageDriver) {
    return this.#operation.apply({ ...this.#state, storage });
  }

  static async prepare<TCtx extends object>(
    context: Omit<OperationContext<TCtx>, "def">,
    adapters: OperationAdapters,
  ): Promise<PreparedCollection<TCtx>> {
    const def = context.collections[context.req.collection];
    if (!def) throw new NotFoundError(`Unknown collection: ${context.req.collection}`);
    const operation = new operations[context.req.operation](adapters);
    return new PreparedCollection(operation, await operation.prepare({ ...context, def }));
  }
}

export async function prepareCollection<TCtx extends object>(
  context: Omit<OperationContext<TCtx>, "def">,
  adapters: OperationAdapters,
): Promise<PreparedCollection<TCtx>> {
  return PreparedCollection.prepare(context, adapters);
}
