import { expectTypeOf, test } from "vite-plus/test";
import type { ActionRegistry, CollectionsDef } from "@takibi/api";
import type { JsonValue } from "@takibi/shared-types";
import type { StorageDriver } from "@takibi/storage";
import type {
  InvocationAdapters,
  InvocationExecutionView,
  InternalInvocationTypeMap,
} from "@takibi/invocation-lifecycle";
import type { ActionInvocation } from "../src/action-executor";
import type { executeResolvedCollection, ExecuteRequest } from "../src/executor";
import type {
  TakibiActionWork,
  TakibiApplyWork,
  TakibiCollectionWork,
  TakibiInvocationRuntime,
  TakibiInvocationTypeMap,
  TakibiNoneWork,
  TakibiPrepared,
  TakibiPublicInvocation,
  TakibiWireInvocation,
} from "@takibi/worker-runtime";
import type { InternalLogger } from "@takibi/worker-runtime";
import type { TakibiFailure } from "@takibi/shared-types";
import type { CollectionReadRequest } from "@takibi/worker-runtime";

type AppContext = { readonly tenantId: string };
type AppServices = { readonly queue: { readonly name: string } };
type AppMap = TakibiInvocationTypeMap<AppContext, AppServices>;

test("pinned map extends the contract type map", () => {
  expectTypeOf<TakibiInvocationTypeMap>().toExtend<InternalInvocationTypeMap>();
  expectTypeOf<AppMap>().toExtend<InternalInvocationTypeMap>();
});

test("Durable Object and in-process share the same pinned slots", () => {
  type DurableObjectMap = TakibiInvocationTypeMap<AppContext, AppServices>;
  type InProcessMap = TakibiInvocationTypeMap<AppContext, AppServices>;
  expectTypeOf<DurableObjectMap>().toEqualTypeOf<InProcessMap>();
  expectTypeOf<InvocationAdapters<DurableObjectMap>>().toEqualTypeOf<
    InvocationAdapters<InProcessMap>
  >();
});

test("slots match current runtime types", () => {
  expectTypeOf<AppMap["wireInvocation"]>().toEqualTypeOf<TakibiWireInvocation>();
  expectTypeOf<ActionInvocation>().toExtend<AppMap["wireInvocation"]>();
  expectTypeOf<ExecuteRequest>().toExtend<AppMap["wireInvocation"]>();
  expectTypeOf<CollectionReadRequest>().toExtend<AppMap["wireInvocation"]>();

  expectTypeOf<AppMap["invocation"]>().toEqualTypeOf<TakibiPublicInvocation>();
  expectTypeOf<AppMap["invocation"]>().not.toHaveProperty("input");

  expectTypeOf<AppMap["runtime"]["collections"]>().toEqualTypeOf<CollectionsDef<AppContext>>();
  expectTypeOf<AppMap["runtime"]["storage"]>().toEqualTypeOf<StorageDriver>();
  expectTypeOf<AppMap["runtime"]["registry"]>().toEqualTypeOf<ActionRegistry>();
  expectTypeOf<AppMap["context"]>().toEqualTypeOf<AppContext>();
  expectTypeOf<AppMap["currentContext"]>().toEqualTypeOf<unknown>();
  expectTypeOf<AppMap["runtime"]["logger"]>().toEqualTypeOf<InternalLogger | undefined>();
  expectTypeOf<InternalLogger>().toEqualTypeOf<import("@takibi/logger").InternalLogger>();
  expectTypeOf<AppMap["runtime"]["services"]>().toEqualTypeOf<AppServices>();
  expectTypeOf<AppMap["rawInput"]>().toEqualTypeOf<unknown>();
  expectTypeOf<AppMap["input"]>().toEqualTypeOf<unknown>();
  expectTypeOf<TakibiActionWork>().toExtend<AppMap["noneWork"]>();
  expectTypeOf<TakibiCollectionWork>().toExtend<AppMap["noneWork"]>();
  expectTypeOf<AppMap["fullWork"]>().toEqualTypeOf<TakibiActionWork>();
  expectTypeOf<AppMap["result"]>().toEqualTypeOf<
    JsonValue | Awaited<ReturnType<typeof executeResolvedCollection>>
  >();
  expectTypeOf<AppMap["failure"]>().toEqualTypeOf<TakibiFailure<string>>();
});

test("runtime bag uses pinned collections, storage, registry, logger, and services", () => {
  expectTypeOf<AppMap["runtime"]>().toEqualTypeOf<
    TakibiInvocationRuntime<AppContext, AppServices>
  >();
  expectTypeOf<
    InvocationExecutionView<AppMap>["runtime"]["services"]
  >().toEqualTypeOf<AppServices>();
  expectTypeOf<InvocationExecutionView<AppMap>["runtime"]["collections"]>().toEqualTypeOf<
    CollectionsDef<AppContext>
  >();
  expectTypeOf<InvocationExecutionView<AppMap>["baseContext"]>().toEqualTypeOf<AppContext>();
  expectTypeOf<InvocationExecutionView<AppMap>["context"]>().toEqualTypeOf<unknown>();
});

test("transaction adapter bindings retain their map relationships", () => {
  type Contracts = InvocationAdapters<AppMap>;
  type State = InvocationExecutionView<AppMap>;
  type OtherContext = { readonly clinicId: number };
  type OtherMap = TakibiInvocationTypeMap<OtherContext, AppServices>;
  type OtherState = InvocationExecutionView<OtherMap>;

  expectTypeOf<Contracts["transactionNone"]["prepare"]>().parameter(0).toEqualTypeOf<State>();
  expectTypeOf<Contracts["transactionNone"]["prepare"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiNoneWork>();
  expectTypeOf<Contracts["transactionNone"]["apply"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiPrepared<AppContext>>();
  expectTypeOf<Contracts["transactionApply"]["prepare"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiApplyWork>();
  expectTypeOf<Contracts["transactionFull"]["prepare"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiActionWork>();
  expectTypeOf<Contracts["transactionFull"]["apply"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiPrepared<AppContext>>();

  const rejectedBindings = (
    contracts: Contracts,
    state: State,
    otherState: OtherState,
    prepared: TakibiPrepared<AppContext>,
    otherPrepared: TakibiPrepared<OtherContext>,
    work: TakibiNoneWork,
    otherWork: Readonly<{ kind: "foreign" }>,
    storage: StorageDriver,
  ) => {
    void contracts.transactionNone.prepare(state, work, storage);
    void contracts.transactionNone.apply(state, prepared, storage);
    // @ts-expect-error A phase view from another context map cannot be rebound.
    void contracts.transactionNone.prepare(otherState, work, storage);
    // @ts-expect-error Prepared work must carry the same context as the bound contract.
    void contracts.transactionNone.apply(state, otherPrepared, storage);
    // @ts-expect-error Work must match the none work slot bound to the class.
    void contracts.transactionNone.prepare(state, otherWork, storage);
  };

  expectTypeOf(rejectedBindings).toBeFunction();
});

test("collection execution and authorized documents retain their concrete types", () => {
  type OperationResult = Awaited<ReturnType<typeof import("../src/executor").executeOperation>>;
  type ResolvedResult = Awaited<ReturnType<typeof executeResolvedCollection>>;
  expectTypeOf<OperationResult>().not.toBeUnknown();
  expectTypeOf<OperationResult>().toEqualTypeOf<ResolvedResult>();
  expectTypeOf<
    import("../src/action-resolution").AuthorizedAction<AppContext>["document"]
  >().toEqualTypeOf<import("@takibi/storage").StoredDocument | undefined>();
});
