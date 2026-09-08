import { expectTypeOf, test } from "vite-plus/test";
import type { ActionRegistry, CollectionsDef } from "@takibi/takibi-api";
import type { JsonValue } from "@takibi/takibi-shared-types";
import type { StorageDriver } from "@takibi/takibi-storage";
import type {
  InvocationAdapters,
  InvocationExecutionView,
  InternalInvocationRuntime,
  InternalInvocationTypeMap,
} from "@takibi/takibi-worker-runtime-contract";
import type { ActionInvocation } from "../src/action-executor";
import type { ExecuteRequest } from "../src/executor";
import { createInvocationTransactionBoundaryContracts } from "../src/invocation-paths";
import type {
  TakibiActionWork,
  TakibiApplyWork,
  TakibiCollectionWork,
  TakibiInvocationTypeMap,
  TakibiNoneWork,
  TakibiPrepared,
  TakibiPublicInvocation,
  TakibiWireInvocation,
} from "../src/invocation-type-map";
import type { InternalLogger } from "../src/logging";
import type { TakibiFailure } from "@takibi/takibi-shared-types";
import type { CollectionReadRequest } from "../src/protocol";

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

  expectTypeOf<AppMap["collections"]>().toEqualTypeOf<CollectionsDef<AppContext>>();
  expectTypeOf<AppMap["storage"]>().toEqualTypeOf<StorageDriver>();
  expectTypeOf<AppMap["registry"]>().toEqualTypeOf<ActionRegistry>();
  expectTypeOf<AppMap["context"]>().toEqualTypeOf<AppContext>();
  expectTypeOf<AppMap["logger"]>().toEqualTypeOf<InternalLogger | undefined>();
  expectTypeOf<AppMap["services"]>().toEqualTypeOf<AppServices>();
  expectTypeOf<AppMap["rawInput"]>().toEqualTypeOf<unknown>();
  expectTypeOf<AppMap["input"]>().toEqualTypeOf<unknown>();
  expectTypeOf<TakibiActionWork>().toExtend<AppMap["noneWork"]>();
  expectTypeOf<TakibiCollectionWork>().toExtend<AppMap["noneWork"]>();
  expectTypeOf<AppMap["fullWork"]>().toEqualTypeOf<TakibiActionWork>();
  expectTypeOf<AppMap["result"]>().toEqualTypeOf<JsonValue>();
  expectTypeOf<AppMap["failure"]>().toEqualTypeOf<TakibiFailure<string>>();
});

test("runtime bag uses pinned collections, storage, registry, logger, and services", () => {
  expectTypeOf<InternalInvocationRuntime<AppMap>>().toEqualTypeOf<{
    readonly collections: CollectionsDef<AppContext>;
    readonly storage: StorageDriver;
    readonly registry: ActionRegistry;
    readonly logger: InternalLogger | undefined;
    readonly services: AppServices;
  }>();
});

test("transaction-boundary class bindings retain their map relationships", () => {
  type Contracts = ReturnType<
    typeof createInvocationTransactionBoundaryContracts<AppContext, AppServices>
  >;
  type State = InvocationExecutionView<AppMap>;
  type OtherContext = { readonly clinicId: number };
  type OtherMap = TakibiInvocationTypeMap<OtherContext, AppServices>;
  type OtherState = InvocationExecutionView<OtherMap>;

  expectTypeOf<Contracts["none"]["prepare"]>().parameter(0).toEqualTypeOf<State>();
  expectTypeOf<Contracts["none"]["prepare"]>().parameter(1).toEqualTypeOf<TakibiNoneWork>();
  expectTypeOf<Contracts["none"]["apply"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiPrepared<AppContext>>();
  expectTypeOf<Contracts["apply"]["prepare"]>().parameter(1).toEqualTypeOf<TakibiApplyWork>();
  expectTypeOf<Contracts["full"]["prepareAndApply"]>()
    .parameter(1)
    .toEqualTypeOf<TakibiActionWork>();

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
    void contracts.none.prepare(state, work, storage);
    void contracts.none.apply(state, prepared, storage);
    // @ts-expect-error A phase view from another context map cannot be rebound.
    void contracts.none.prepare(otherState, work, storage);
    // @ts-expect-error Prepared work must carry the same context as the bound contract.
    void contracts.none.apply(state, otherPrepared, storage);
    // @ts-expect-error Work must match the none work slot bound to the class.
    void contracts.none.prepare(state, otherWork, storage);
  };

  expectTypeOf(rejectedBindings).toBeFunction();
});
