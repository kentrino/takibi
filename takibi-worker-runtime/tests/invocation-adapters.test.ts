import { expect, expectTypeOf, test } from "vite-plus/test";
import { z } from "zod";
import {
  ActionRegistry,
  createDocumentActionBuilder,
  createRootActionBuilder,
  UnauthorizedError,
  type CollectionsDef,
  type DocumentActionArgs,
  type RootActionArgs,
} from "@takibi/takibi-api";
import { fullAccess, none } from "@takibi/takibi-policy";
import { createDurableObjectStorage } from "@takibi/takibi-storage";
import {
  runInvocation,
  type InvocationAdapters,
  type LocalCallTypeMap,
  type RuntimeAdapterMap,
} from "@takibi/takibi-worker-runtime-contract";
import { createSqliteDurableObjectStorage } from "../../takibi-testing/src/sqlite-storage.server";
import { createBoundInvocationAdapters, type TakibiAdapterMap } from "../src/adapter-map";
import { getTakibiRawInput, toTakibiInvocation } from "../src/invocation-adapters";
import { executeAction } from "../src/action-executor";
import { executeOperation } from "../src/executor";
import {
  resolveLocalAdapterMap,
  resolveLocalExecution,
  type LocalExecution,
  type TakibiRuntimeAdapterMap,
} from "../src/invocation-execution";
import { InvocationPrepareApply } from "../src/invocation-paths";
import type { CollectionReadRequest, WireResponse } from "../src/protocol";
import { invocationToHttpResponse, invocationToWireResponse } from "../src/invocation-response";
import type { TakibiInvocationTypeMap, TakibiWireInvocation } from "../src/invocation-type-map";

type Ctx = { readonly tenantId: string };
type Map = TakibiInvocationTypeMap<Ctx>;

const Item = z.object({ value: z.string() });

async function createAdapters(actionEvents?: string[]) {
  const collections = {
    items: {
      schema: Item,
      accessPolicy: fullAccess,
    },
  } satisfies CollectionsDef<Ctx>;
  const registry = new ActionRegistry();
  registry.registerRootActions(
    {
      ping: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .policy(fullAccess)
        .handler(() => ({ ok: true })),
      atomicPing: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .atomic()
        .policy(fullAccess)
        .handler(() => ({ ok: true })),
      atomicOrdered: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .use((ctx) => {
          actionEvents?.push("guard");
          return ctx;
        })
        .input(
          z.string().transform((value) => {
            actionEvents?.push("parse");
            return value;
          }),
        )
        .atomic()
        .policy(() => {
          actionEvents?.push("gate");
          return fullAccess;
        })
        .handler(({ input }) => {
          actionEvents?.push("handler");
          return { input };
        }),
      atomicPolicyAdd: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .atomic()
        .policy(fullAccess)
        .handler(async ({ collections: policyCollections }) =>
          policyCollections.items.add({ value: "nested" }, { id: "nested" }),
        ),
      atomicPolicyFailure: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .atomic()
        .policy(fullAccess)
        .handler(async ({ collections: policyCollections }) => {
          await policyCollections.items.add({ value: 1 as unknown as string }, { id: "invalid" });
          return { unreachable: true };
        }),
    },
    new Set(["items"]),
  );
  registry.registerCollectionActions("items", {
    echo: createDocumentActionBuilder<
      Ctx,
      DocumentActionArgs<Ctx, typeof collections, (typeof collections)["items"]>,
      RootActionArgs<Ctx, typeof collections>,
      { value: string }
    >("items")
      .policy(fullAccess)
      .handler(({ doc }) => ({ value: doc.value })),
    ordered: createDocumentActionBuilder<
      Ctx,
      DocumentActionArgs<Ctx, typeof collections, (typeof collections)["items"]>,
      RootActionArgs<Ctx, typeof collections>,
      string
    >("items")
      .use((ctx) => {
        actionEvents?.push("guard");
        return ctx;
      })
      .input(
        z.string().transform((value) => {
          actionEvents?.push("parse");
          return value;
        }),
      )
      .policy(() => {
        actionEvents?.push("gate");
        return fullAccess;
      })
      .handler(({ input }) => {
        actionEvents?.push("handler");
        return { input };
      }),
    atomicOrdered: createDocumentActionBuilder<
      Ctx,
      DocumentActionArgs<Ctx, typeof collections, (typeof collections)["items"]>,
      RootActionArgs<Ctx, typeof collections>,
      string
    >("items")
      .use((ctx) => {
        actionEvents?.push("guard");
        return ctx;
      })
      .input(
        z.string().transform((value) => {
          actionEvents?.push("parse");
          return value;
        }),
      )
      .atomic()
      .policy(() => {
        actionEvents?.push("gate");
        return fullAccess;
      })
      .handler(({ input }) => {
        actionEvents?.push("handler");
        return { input };
      }),
    guardDenied: createDocumentActionBuilder<
      Ctx,
      DocumentActionArgs<Ctx, typeof collections, (typeof collections)["items"]>,
      RootActionArgs<Ctx, typeof collections>,
      string
    >("items")
      .use(() => {
        actionEvents?.push("guard");
        throw new UnauthorizedError("guard denied");
      })
      .input(
        z.string().transform((value) => {
          actionEvents?.push("parse");
          return value;
        }),
      )
      .policy(() => {
        actionEvents?.push("gate");
        return fullAccess;
      })
      .handler(() => {
        actionEvents?.push("handler");
        return null;
      }),
    gateDenied: createDocumentActionBuilder<
      Ctx,
      DocumentActionArgs<Ctx, typeof collections, (typeof collections)["items"]>,
      RootActionArgs<Ctx, typeof collections>,
      string
    >("items")
      .input(
        z.string().transform((value) => {
          actionEvents?.push("parse");
          return value;
        }),
      )
      .policy(() => {
        actionEvents?.push("gate");
        return none;
      })
      .handler(() => {
        actionEvents?.push("handler");
        return null;
      }),
    bump: createDocumentActionBuilder<
      Ctx,
      DocumentActionArgs<Ctx, typeof collections, (typeof collections)["items"]>,
      RootActionArgs<Ctx, typeof collections>,
      { value: string }
    >("items")
      .policy(fullAccess)
      .atomic()
      .handler(async ({ doc, $collection }) => {
        await $collection.set(doc.id, { value: `${doc.value}!` });
        return { id: doc.id, value: `${doc.value}!` };
      }),
  });
  const storage = createDurableObjectStorage(createSqliteDurableObjectStorage());
  const adapters: InvocationAdapters<Map> = await createBoundInvocationAdapters<Ctx>({
    collections,
    storage,
    registry,
    logger: undefined,
    services: {},
  });
  return { adapters, storage, collections, registry };
}

function run(adapters: InvocationAdapters<Map>, wireInvocation: TakibiWireInvocation) {
  return runInvocation<Map>(adapters, {
    request: { wireInvocation, context: { tenantId: "tenant-a" } },
  });
}

async function planFor(adapters: InvocationAdapters<Map>, wireInvocation: TakibiWireInvocation) {
  const observed = await run(adapters, wireInvocation);
  if (observed.plan === undefined) {
    throw new Error("Expected invocation plan");
  }
  return observed.plan;
}

test("toInvocation drops raw input and getRawInput reads it back", () => {
  const action = {
    kind: "action" as const,
    scope: "items",
    name: "echo",
    id: "i1",
    input: { title: "secret" },
  };
  expect(toTakibiInvocation(action)).toEqual({
    kind: "action",
    scope: "items",
    name: "echo",
    id: "i1",
  });
  expect(getTakibiRawInput(action)).toEqual({ title: "secret" });

  const write = {
    kind: "collection" as const,
    collection: "items",
    operation: "add" as const,
    input: { value: "hello" },
  };
  expect(toTakibiInvocation(write)).toEqual({
    kind: "collection",
    collection: "items",
    operation: "add",
  });
  expect(getTakibiRawInput(write)).toEqual({ value: "hello" });

  const read = {
    kind: "collection" as const,
    collection: "items",
    operation: "get" as const,
    id: "i1",
  };
  expect(toTakibiInvocation(read)).toEqual(read);
  expect(getTakibiRawInput(read)).toBeUndefined();
});

test("bound adapters satisfy the contract bag", async () => {
  const { adapters } = await createAdapters();
  expectTypeOf(adapters).toExtend<InvocationAdapters<Map>>();
});

test("bound helper and production resolve the same registered adapters", async () => {
  const { adapters, storage } = await createAdapters();
  const map = await resolveLocalAdapterMap({
    ...adapters.invocationRuntime,
    storage,
    spanKind: "internal",
  });

  expect(adapters.invocationToInvocation).toBe(map.invocationToInvocation);
  expect(adapters.invocationGetRawInput).toBe(map.invocationGetRawInput);
  expect(adapters.invocationCreatePlan).toBe(map.invocationCreatePlan);
  expect(adapters.invocationToFailure).toBe(map.invocationToFailure);
  expect(adapters.invocationSnapshotObserverEvent).toBe(map.invocationSnapshotObserverEvent);
  expect(adapters.invocationNotify).toBe(map.invocationNotify);
  expect(adapters.transactionClassifyFailure).toBe(map.transactionClassifyFailure);
  expect(adapters.transactionNone).toBeInstanceOf(InvocationPrepareApply);
  expect(map.transactionNone).toBe(map.invocationPrepareApply);
  expect(map.invocationRun).not.toBe(map.invocationCoreRun);
});

test("tatenuki resolves an isolated adapter map without retaining invocation state", async () => {
  const { adapters } = await createAdapters();
  const first = await resolveLocalAdapterMap({
    ...adapters.invocationRuntime,
    spanKind: "internal",
  });
  const secondRuntime = {
    ...adapters.invocationRuntime,
    services: { runtime: "second" },
  };
  const second = await resolveLocalAdapterMap({
    ...secondRuntime,
    spanKind: "internal",
  });

  expect(first.invocationRuntime.services).toBe(adapters.invocationRuntime.services);
  expect(second.invocationRuntime.services).toEqual({ runtime: "second" });
  expect(first.invocationRuntime.services).not.toBe(second.invocationRuntime.services);

  const wireInvocation: TakibiWireInvocation = {
    kind: "collection",
    collection: "items",
    operation: "get",
    id: "missing",
  };
  const [tenantA, tenantB] = await Promise.all([
    first.invocationRun({
      request: { wireInvocation, context: { tenantId: "tenant-a" } },
    }),
    first.invocationRun({
      request: { wireInvocation, context: { tenantId: "tenant-b" } },
    }),
  ]);

  expect(tenantA.context).toEqual({ tenantId: "tenant-a" });
  expect(tenantB.context).toEqual({ tenantId: "tenant-b" });
});

test("runtime plans every collection operation", async () => {
  const { adapters } = await createAdapters();
  const cases = [
    {
      invocation: {
        kind: "collection",
        collection: "items",
        operation: "get",
        id: "missing",
      },
      capability: "read-only",
      transactionBoundary: "none",
    },
    {
      invocation: { kind: "collection", collection: "items", operation: "list" },
      capability: "read-only",
      transactionBoundary: "none",
    },
    {
      invocation: { kind: "collection", collection: "items", operation: "count" },
      capability: "read-only",
      transactionBoundary: "none",
    },
    {
      invocation: {
        kind: "collection",
        collection: "items",
        operation: "add",
        id: "added",
        input: { value: "added" },
      },
      capability: "writes",
      transactionBoundary: "apply",
    },
    {
      invocation: {
        kind: "collection",
        collection: "items",
        operation: "set",
        id: "set",
        input: { value: "set" },
      },
      capability: "writes",
      transactionBoundary: "none",
    },
    {
      invocation: {
        kind: "collection",
        collection: "items",
        operation: "update",
        id: "missing",
        input: { value: "updated" },
      },
      capability: "writes",
      transactionBoundary: "none",
    },
    {
      invocation: {
        kind: "collection",
        collection: "items",
        operation: "delete",
        id: "missing",
      },
      capability: "writes",
      transactionBoundary: "none",
    },
  ] as const satisfies readonly {
    invocation: TakibiWireInvocation;
    capability: "read-only" | "writes";
    transactionBoundary: "none" | "apply" | "full";
  }[];

  for (const expected of cases) {
    const plan = await planFor(adapters, expected.invocation);
    expect(plan).toMatchObject({
      transactionBoundary: expected.transactionBoundary,
      work: {
        kind: "collection",
        capability: expected.capability,
        request: {
          operation: expected.invocation.operation,
        },
      },
    });
  }
});

test("runtime plans action transaction boundaries from definitions", async () => {
  const { adapters } = await createAdapters();
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "action-item",
    input: { value: "hello" },
  });
  const cases = [
    {
      invocation: { kind: "action", scope: "$", name: "ping" },
      target: "detached",
      transactionBoundary: "none",
    },
    {
      invocation: { kind: "action", scope: "$", name: "atomicPing" },
      target: "detached",
      transactionBoundary: "apply",
    },
    {
      invocation: { kind: "action", scope: "items", name: "echo", id: "action-item" },
      target: "document",
      transactionBoundary: "none",
    },
    {
      invocation: { kind: "action", scope: "items", name: "bump", id: "action-item" },
      target: "document",
      transactionBoundary: "full",
    },
  ] as const satisfies readonly {
    invocation: TakibiWireInvocation;
    target: "detached" | "document";
    transactionBoundary: "none" | "apply" | "full";
  }[];

  for (const expected of cases) {
    const plan = await planFor(adapters, expected.invocation);
    expect(plan).toMatchObject({
      transactionBoundary: expected.transactionBoundary,
      work: {
        kind: "action",
        capability: "may-write",
        definition: { target: expected.target },
      },
    });
    if (plan.work.kind === "action") {
      expect(plan.work).not.toHaveProperty("document");
      expect(plan.work).not.toHaveProperty("grant");
    }
  }
});

test("orchestrator add writes through the runner-owned transaction", async () => {
  const { adapters, storage } = await createAdapters();
  let transactions = 0;
  const counted = {
    ...storage,
    transaction<T>(callback: (scoped: typeof storage) => Promise<T>) {
      transactions += 1;
      return storage.transaction(callback);
    },
  };
  const transactional = await createBoundInvocationAdapters<Ctx>({
    ...adapters.invocationRuntime,
    storage: counted,
  });

  const added = await run(transactional, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });
  expect(added.settlement).toMatchObject({
    outcome: "succeeded",
    result: expect.objectContaining({ id: "i1", value: "hello" }),
  });
  expect(added.input).toEqual({ status: "raw", value: { value: "hello" } });
  expect(transactions).toBe(1);

  const got = await run(transactional, {
    kind: "collection",
    collection: "items",
    operation: "get",
    id: "i1",
  });
  expect(got.settlement).toMatchObject({
    outcome: "succeeded",
    result: expect.objectContaining({ id: "i1", value: "hello" }),
  });
  expect(transactions).toBe(1);
});

test("direct add uses the same apply-boundary transaction path", async () => {
  const { storage, collections } = await createAdapters();
  let transactions = 0;
  const counted = {
    ...storage,
    transaction<T>(callback: (scoped: typeof storage) => Promise<T>) {
      transactions += 1;
      return storage.transaction(callback);
    },
  };

  await expect(
    executeOperation(
      collections,
      counted,
      { tenantId: "tenant-a" },
      {
        kind: "collection",
        collection: "items",
        operation: "add",
        id: "direct",
        input: { value: "direct" },
      },
    ),
  ).resolves.toMatchObject({ id: "direct", value: "direct" });
  expect(transactions).toBe(1);
});

test("orchestrator runs detached and document actions from written state", async () => {
  const { adapters } = await createAdapters();
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });

  const ping = await run(adapters, {
    kind: "action",
    scope: "$",
    name: "ping",
  });
  expect(ping.settlement).toMatchObject({
    outcome: "succeeded",
    result: { ok: true },
  });
  expect(ping.plan).toMatchObject({
    transactionBoundary: "none",
    work: {
      kind: "action",
      definition: expect.objectContaining({ target: "detached", atomic: false }),
    },
  });

  const echo = await run(adapters, {
    kind: "action",
    scope: "items",
    name: "echo",
    id: "i1",
  });
  expect(echo.settlement).toMatchObject({
    outcome: "succeeded",
    result: { value: "hello" },
  });
});

test("orchestrator orders guard, document load/gate, parse, then handler", async () => {
  const events: string[] = [];
  const { adapters, storage } = await createAdapters(events);
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });
  events.length = 0;
  const observedStorage = {
    ...storage,
    async get(collection: string, id: string) {
      events.push("load");
      return storage.get(collection, id);
    },
  };
  const ordered = await createBoundInvocationAdapters<Ctx>({
    ...adapters.invocationRuntime,
    storage: observedStorage,
  });

  const result = await run(ordered, {
    kind: "action",
    scope: "items",
    name: "ordered",
    id: "i1",
    input: "hello",
  });

  expect(result.settlement).toMatchObject({ outcome: "succeeded" });
  expect(events).toEqual(["guard", "load", "gate", "parse", "handler"]);
});

test("guard failure performs no document load or later action phase", async () => {
  const events: string[] = [];
  const { adapters, storage } = await createAdapters(events);
  let loads = 0;
  const guarded = await createBoundInvocationAdapters<Ctx>({
    ...adapters.invocationRuntime,
    storage: {
      ...storage,
      async get(collection, id) {
        loads += 1;
        return storage.get(collection, id);
      },
    },
  });

  const result = await run(guarded, {
    kind: "action",
    scope: "items",
    name: "guardDenied",
    id: "does-not-matter",
    input: "hello",
  });

  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { code: "UNAUTHORIZED" } },
  });
  expect(loads).toBe(0);
  expect(events).toEqual(["guard"]);
});

test("document gate denial prevents input parsing and handler execution", async () => {
  const events: string[] = [];
  const { adapters } = await createAdapters(events);
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });
  events.length = 0;

  const result = await run(adapters, {
    kind: "action",
    scope: "items",
    name: "gateDenied",
    id: "i1",
    input: "hello",
  });

  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { code: "FORBIDDEN" } },
  });
  expect(events).toEqual(["gate"]);
});

test("direct executeAction matches orchestrated guard, load/gate, parse, handler order", async () => {
  const events: string[] = [];
  const { adapters, storage, collections, registry } = await createAdapters(events);
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });
  events.length = 0;
  const observedStorage = {
    ...storage,
    async get(collection: string, id: string) {
      events.push("load");
      return storage.get(collection, id);
    },
  };

  await executeAction(
    registry,
    collections,
    observedStorage,
    { tenantId: "tenant-a" },
    {
      kind: "action",
      scope: "items",
      name: "ordered",
      id: "i1",
      input: "hello",
    },
  );

  expect(events).toEqual(["guard", "load", "gate", "parse", "handler"]);
});

test("detached atomic actions gate and parse before their handler transaction", async () => {
  const events: string[] = [];
  const { adapters, storage, collections, registry } = await createAdapters(events);
  const observedStorage = {
    ...storage,
    transaction<T>(callback: (scoped: typeof storage) => Promise<T>) {
      events.push("transaction");
      return storage.transaction(callback);
    },
  };
  const orchestrated = await createBoundInvocationAdapters<Ctx>({
    ...adapters.invocationRuntime,
    storage: observedStorage,
  });

  const invocation = {
    kind: "action" as const,
    scope: "$",
    name: "atomicOrdered",
    input: "hello",
  };
  const result = await run(orchestrated, invocation);
  expect(result.settlement).toMatchObject({ outcome: "succeeded" });
  expect(events).toEqual(["guard", "gate", "parse", "transaction", "handler"]);

  events.length = 0;
  await executeAction(registry, collections, observedStorage, { tenantId: "tenant-a" }, invocation);
  expect(events).toEqual(["guard", "gate", "parse", "transaction", "handler"]);
});

test("parsed input is observable when a detached transaction cannot start", async () => {
  const { adapters } = await createAdapters();
  let observedInput: unknown;
  let inputAvailable = false;
  const failing = {
    ...adapters,
    transactionRun: async () => {
      throw new Error("TRANSACTION_START_FAILED");
    },
    invocationNotify(context) {
      inputAvailable = context.inputAvailable;
      observedInput = context.input;
    },
  } satisfies InvocationAdapters<Map>;

  const result = await run(failing, {
    kind: "action",
    scope: "$",
    name: "atomicOrdered",
    input: "hello",
  });

  expect(result.input).toEqual({ status: "validated", value: "hello" });
  expect(inputAvailable).toBe(true);
  expect(observedInput).toBe("hello");
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "TRANSACTION_START_FAILED" } },
  });
});

test("transaction-bound policy calls reuse scope, return values, and propagate failures", async () => {
  const { adapters, storage, collections, registry } = await createAdapters();
  let transactions = 0;
  const counted = {
    ...storage,
    transaction<T>(callback: (scoped: typeof storage) => Promise<T>) {
      transactions += 1;
      return storage.transaction(callback);
    },
  };
  const notified: string[] = [];
  const transactional = {
    ...(await createBoundInvocationAdapters<Ctx>({
      ...adapters.invocationRuntime,
      storage: counted,
    })),
    invocationNotify: (context) => {
      notified.push(context.outcome);
    },
  } satisfies InvocationAdapters<Map>;

  const added = await run(transactional, {
    kind: "action",
    scope: "$",
    name: "atomicPolicyAdd",
  });
  expect(added.settlement).toMatchObject({
    outcome: "succeeded",
    result: expect.objectContaining({ id: "nested", value: "nested" }),
  });
  expect(transactions).toBe(1);
  expect(notified).toEqual(["succeeded"]);

  const failed = await run(transactional, {
    kind: "action",
    scope: "$",
    name: "atomicPolicyFailure",
  });
  expect(failed.settlement).toMatchObject({ outcome: "failed", stage: "execute" });
  expect(transactions).toBe(2);
  expect(notified).toEqual(["succeeded", "failed"]);
  await expect(storage.get("items", "invalid")).resolves.toBeNull();

  await expect(
    executeAction(
      registry,
      collections,
      counted,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "atomicPolicyFailure" },
    ),
  ).rejects.toThrow();
  expect(transactions).toBe(3);
  expect(notified).toEqual(["succeeded", "failed"]);
});

test("settled failure projects to a wire response with the mapped status", async () => {
  const { adapters } = await createAdapters();
  const failed = await run(adapters, {
    kind: "action",
    scope: "$",
    name: "ghost",
  });
  expect(
    invocationToWireResponse({ invocationRuntime: {}, localRequest: undefined })({
      invocation: failed,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
});

test("observer nested result mutation cannot change wire or HTTP responses", async () => {
  const { adapters } = await createAdapters();
  const observed = await run(
    {
      ...adapters,
      invocationNotify(context) {
        if (context.outcome !== "succeeded") throw new Error("Expected success");
        (context.result as { ok: boolean }).ok = false;
      },
    },
    { kind: "action", scope: "$", name: "ping" },
  );

  const deps = { invocationRuntime: {}, localRequest: undefined };
  expect(invocationToWireResponse(deps)({ invocation: observed })).toEqual({
    ok: true,
    data: { ok: true },
  });
  await expect(invocationToHttpResponse(deps)({ invocation: observed }).json()).resolves.toEqual({
    ok: true,
    data: { ok: true },
  });
});

test("observer nested mapped failure mutation cannot change wire or HTTP responses", async () => {
  const { adapters } = await createAdapters();
  const observed = await run(
    {
      ...adapters,
      invocationNotify(context) {
        if (context.outcome !== "failed" || context.failure.kind !== "mapped") {
          throw new Error("Expected mapped failure");
        }
        const failure = context.failure.value;
        failure.code = "MUTATED";
        failure.status = 418;
      },
    },
    { kind: "action", scope: "$", name: "ghost" },
  );

  const deps = { invocationRuntime: {}, localRequest: undefined };
  expect(invocationToWireResponse(deps)({ invocation: observed })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
  const response = invocationToHttpResponse(deps)({ invocation: observed });
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
});

test("local execution returns wire success and failure without throwing", async () => {
  const { adapters, storage } = await createAdapters();
  const local = await resolveLocalExecution({
    ...adapters.invocationRuntime,
    storage,
    spanKind: "internal",
  });
  await expect(
    local.execute(
      { tenantId: "tenant-a" },
      {
        kind: "collection",
        collection: "items",
        operation: "add",
        id: "i1",
        input: { value: "hello" },
      },
    ),
  ).resolves.toMatchObject({
    ok: true,
    data: { id: "i1", value: "hello" },
  });
  await expect(
    local.execute({ tenantId: "tenant-a" }, { kind: "action", scope: "$", name: "ghost" }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
});

test("production local batch continues after one item failure", async () => {
  const { adapters, storage } = await createAdapters();
  const local = await resolveLocalExecution({
    ...adapters.invocationRuntime,
    storage,
    spanKind: "internal",
  });
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });

  await expect(
    local.executeBatch({ tenantId: "tenant-a" }, [
      { kind: "collection", collection: "items", operation: "get", id: "missing" },
      { kind: "collection", collection: "items", operation: "get", id: "i1" },
    ]),
  ).resolves.toEqual({
    ok: true,
    data: [
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "NOT_FOUND" }) }),
      expect.objectContaining({ ok: true, data: expect.objectContaining({ id: "i1" }) }),
    ],
  });
});

test("runtime adapter map extends the contract map with assembly slots", () => {
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toExtend<TakibiAdapterMap<Ctx>>();
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toExtend<
    RuntimeAdapterMap<
      Map,
      LocalCallTypeMap<Map, WireResponse, CollectionReadRequest>,
      LocalExecution<Ctx>
    >
  >();
  expectTypeOf<TakibiAdapterMap<Ctx>>().not.toHaveProperty("invocationCoreRun");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("invocationCoreRun");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("callDecode");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("callSingle");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().not.toHaveProperty("wireCallSingle");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("localExecution");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("invocationPolicy");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("invocationSchema");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("invocationActionHandler");
  expectTypeOf<TakibiRuntimeAdapterMap<Ctx>>().toHaveProperty("invocationPrepareApply");
});

test("DI override of invocationPolicy is used by the local execution path", async () => {
  const { adapters, storage } = await createAdapters();
  const events: string[] = [];
  const map = await resolveLocalAdapterMap(
    {
      ...adapters.invocationRuntime,
      storage,
      spanKind: "internal",
    },
    {
      invocationPolicy: {
        async evaluateCollection() {
          events.push("collection");
          throw new Error("overridden collection policy");
        },
        async evaluateAction() {
          events.push("action");
          throw new Error("overridden action policy");
        },
      },
    },
  );

  expect(map.invocationPrepareApply).toBeInstanceOf(InvocationPrepareApply);
  expect(map.transactionNone).toBe(map.invocationPrepareApply);
  expect(map.transactionApply).toBe(map.invocationPrepareApply);
  expect(map.transactionFull).toBe(map.invocationPrepareApply);

  const result = await map.invocationRun({
    request: {
      wireInvocation: { kind: "action", scope: "$", name: "ping" },
      context: { tenantId: "tenant-a" },
    },
  });
  expect(events).toEqual(["action"]);
  expect(result.settlement.outcome).toBe("failed");
});

test("DI override of invocationPolicy is used by direct executeAction and invocationRun", async () => {
  const authorizeError = new Error("OVERRIDDEN_POLICY");
  const { adapters, storage, collections, registry } = await createAdapters();
  const map = await resolveLocalAdapterMap(
    {
      ...adapters.invocationRuntime,
      storage,
      spanKind: "internal",
    },
    {
      invocationPolicy: {
        async evaluateCollection() {
          throw new Error("overridden collection policy");
        },
        async evaluateAction() {
          throw authorizeError;
        },
      },
    },
  );

  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "ping" },
      undefined,
      {},
      map.invocationPrepareApply,
    ),
  ).rejects.toBe(authorizeError);

  const result = await map.invocationRun({
    request: {
      wireInvocation: { kind: "action", scope: "$", name: "ping" },
      context: { tenantId: "tenant-a" },
    },
  });
  expect(result.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "OVERRIDDEN_POLICY" } },
  });
});

test("identify, authorize, and parse keep the original error on both paths", async () => {
  const identifyError = new Error("IDENTIFY_FAILED");
  const authorizeError = new Error("AUTHORIZE_FAILED");
  const parseError = new Error("PARSE_FAILED");
  const { adapters, storage, collections, registry } = await createAdapters();
  registry.registerRootActions(
    {
      taggedIdentify: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .use(() => {
          throw identifyError;
        })
        .policy(fullAccess)
        .handler(() => ({ ok: true })),
      taggedContext: createRootActionBuilder<Ctx, RootActionArgs<Ctx, typeof collections>>()
        .use((ctx) => ({ ...ctx, tenantId: "after-identify" }))
        .input(z.string())
        .policy(fullAccess)
        .handler(() => ({ ok: true })),
    },
    new Set(["items"]),
  );

  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "taggedIdentify" },
    ),
  ).rejects.toBe(identifyError);

  const identified = await run(adapters, { kind: "action", scope: "$", name: "taggedIdentify" });
  expect(identified.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "IDENTIFY_FAILED" } },
  });

  const authorizing = await resolveLocalAdapterMap(
    {
      ...adapters.invocationRuntime,
      storage,
      spanKind: "internal",
    },
    {
      invocationPolicy: {
        async evaluateCollection() {
          throw authorizeError;
        },
        async evaluateAction() {
          throw authorizeError;
        },
      },
    },
  );
  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "taggedContext", input: "hello" },
      undefined,
      {},
      authorizing.invocationPrepareApply,
    ),
  ).rejects.toBe(authorizeError);
  const authorized = await authorizing.invocationRun({
    request: {
      wireInvocation: { kind: "action", scope: "$", name: "taggedContext", input: "hello" },
      context: { tenantId: "tenant-a" },
    },
  });
  expect(authorized.context).toEqual({ tenantId: "after-identify" });
  expect(authorized.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "AUTHORIZE_FAILED" } },
  });

  const parsing = await resolveLocalAdapterMap(
    {
      ...adapters.invocationRuntime,
      storage,
      spanKind: "internal",
    },
    {
      invocationSchema: {
        async parse() {
          throw parseError;
        },
      },
    },
  );
  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "taggedContext", input: "hello" },
      undefined,
      {},
      parsing.invocationPrepareApply,
    ),
  ).rejects.toBe(parseError);
  const parsed = await parsing.invocationRun({
    request: {
      wireInvocation: { kind: "action", scope: "$", name: "taggedContext", input: "hello" },
      context: { tenantId: "tenant-a" },
    },
  });
  expect(parsed.context).toEqual({ tenantId: "after-identify" });
  expect(parsed.input).toEqual({ status: "raw", value: "hello" });
  expect(parsed.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "PARSE_FAILED" } },
  });
});

test("apply and commit failures keep parsed input and the original error", async () => {
  const applyError = new Error("APPLY_FAILED");
  const commitError = new Error("COMMIT_FAILED");
  const { adapters, storage, collections, registry } = await createAdapters();
  const applying = await resolveLocalAdapterMap(
    {
      ...adapters.invocationRuntime,
      storage,
      spanKind: "internal",
    },
    {
      invocationActionHandler: () => ({
        async run() {
          throw applyError;
        },
      }),
    },
  );
  await expect(
    executeAction(
      registry,
      collections,
      storage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "atomicOrdered", input: "hello" },
      undefined,
      {},
      applying.invocationPrepareApply,
    ),
  ).rejects.toBe(applyError);
  const applied = await applying.invocationRun({
    request: {
      wireInvocation: { kind: "action", scope: "$", name: "atomicOrdered", input: "hello" },
      context: { tenantId: "tenant-a" },
    },
  });
  expect(applied.input).toEqual({ status: "validated", value: "hello" });
  expect(applied.settlement).toMatchObject({
    outcome: "failed",
    failure: { kind: "mapped", value: { message: "APPLY_FAILED" } },
  });

  const startError = new Error("TRANSACTION_START_FAILED");
  const startingStorage = {
    ...storage,
    transaction() {
      throw startError;
    },
  };
  await expect(
    executeAction(
      registry,
      collections,
      startingStorage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "atomicOrdered", input: "hello" },
    ),
  ).rejects.toBe(startError);

  const committingStorage = {
    ...storage,
    transaction<T>(callback: (scoped: typeof storage) => Promise<T>) {
      return storage.transaction(callback).then(() => {
        throw commitError;
      });
    },
  };
  await expect(
    executeAction(
      registry,
      collections,
      committingStorage,
      { tenantId: "tenant-a" },
      { kind: "action", scope: "$", name: "atomicOrdered", input: "hello" },
    ),
  ).rejects.toBe(commitError);

  const committing = await resolveLocalAdapterMap(
    {
      ...adapters.invocationRuntime,
      storage,
      spanKind: "internal",
    },
    {
      transactionRun: async (work) => {
        await work(storage);
        throw commitError;
      },
    },
  );
  const committed = await committing.invocationRun({
    request: {
      wireInvocation: { kind: "action", scope: "$", name: "atomicOrdered", input: "hello" },
      context: { tenantId: "tenant-a" },
    },
  });
  expect(committed.input).toEqual({ status: "validated", value: "hello" });
  expect(committed.settlement).toMatchObject({
    outcome: "failed",
    stage: "commit",
    failure: { kind: "mapped", value: { message: "COMMIT_FAILED" } },
  });
});

test("concurrent local invocations keep resolved policy and context apart", async () => {
  const { adapters, storage } = await createAdapters();
  const seen: string[] = [];
  const map = await resolveLocalAdapterMap({
    ...adapters.invocationRuntime,
    storage,
    spanKind: "internal",
  });
  const [left, right] = await Promise.all([
    map.invocationRun({
      request: {
        wireInvocation: { kind: "action", scope: "$", name: "ping" },
        context: { tenantId: "left" },
      },
    }),
    map.invocationRun({
      request: {
        wireInvocation: { kind: "action", scope: "$", name: "ping" },
        context: { tenantId: "right" },
      },
    }),
  ]);
  seen.push(left.context.tenantId, right.context.tenantId);
  expect(seen).toEqual(["left", "right"]);
  expect(left.settlement.outcome).toBe("succeeded");
  expect(right.settlement.outcome).toBe("succeeded");
});

test("local graph instruments invocationRun and leaves invocationCoreRun bare", async () => {
  const events: string[] = [];
  const { adapters, storage } = await createAdapters();
  const map = await resolveLocalAdapterMap({
    ...adapters.invocationRuntime,
    storage,
    logger: {
      emit(event) {
        events.push(event.event);
      },
    },
    spanKind: "internal",
  });
  const request = {
    wireInvocation: {
      kind: "collection" as const,
      collection: "items",
      operation: "get" as const,
      id: "missing",
    },
    context: { tenantId: "tenant-a" },
  };

  expect(map.invocationRun).not.toBe(map.invocationCoreRun);
  await map.invocationCoreRun({ request });
  expect(events).not.toContain("takibi.executor");

  await map.invocationRun({ request });
  expect(events.filter((event) => event === "takibi.executor")).toEqual(["takibi.executor"]);
});

test("resolveLocalExecution is the public entry built from the runtime map", async () => {
  const { adapters, storage } = await createAdapters();
  const execution = await resolveLocalExecution({
    ...adapters.invocationRuntime,
    storage,
    spanKind: "internal",
  });
  await expect(
    execution.execute({ tenantId: "tenant-a" }, { kind: "action", scope: "$", name: "ghost" }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND", status: 404 },
  });
});

test("document atomic load, gate, parse, and handler share the runner transaction", async () => {
  const events: string[] = [];
  const { adapters, storage } = await createAdapters(events);
  await run(adapters, {
    kind: "collection",
    collection: "items",
    operation: "add",
    id: "i1",
    input: { value: "hello" },
  });
  events.length = 0;

  let inTransaction = false;
  const counted = {
    ...storage,
    transaction<T>(callback: (scoped: typeof storage) => Promise<T>) {
      return storage.transaction(async (scoped) => {
        inTransaction = true;
        events.push("transaction");
        try {
          return await callback({
            ...scoped,
            get: async (collection, id) => {
              expect(inTransaction).toBe(true);
              events.push("load");
              return scoped.get(collection, id);
            },
          });
        } finally {
          events.push("transaction:end");
          inTransaction = false;
        }
      });
    },
  };
  const transactional = await createBoundInvocationAdapters<Ctx>({
    ...adapters.invocationRuntime,
    storage: counted,
  });

  const result = await run(transactional, {
    kind: "action",
    scope: "items",
    name: "atomicOrdered",
    id: "i1",
    input: "hello",
  });
  expect(result.settlement).toMatchObject({
    outcome: "succeeded",
    result: { input: "hello" },
  });
  expect(result.plan !== undefined && result.plan.transactionBoundary).toBe("full");
  expect(events).toEqual([
    "transaction",
    "guard",
    "load",
    "gate",
    "parse",
    "handler",
    "transaction:end",
  ]);
  if (result.plan !== undefined && result.plan.work.kind === "action") {
    expect(result.plan.work).not.toHaveProperty("document");
  }
});

test.each(["set", "update"] as const)(
  "%s prepare failure preserves concealment through runInvocation",
  async (operation) => {
    const { adapters, storage } = await createAdapters();
    await run(adapters, {
      kind: "collection",
      collection: "items",
      operation: "add",
      id: "i1",
      input: { value: "hello" },
    });
    let policyCalls = 0;
    const concealed = await createBoundInvocationAdapters<Ctx>({
      ...adapters.invocationRuntime,
      storage,
      collections: {
        items: {
          schema: Item,
          accessPolicy: () => {
            policyCalls += 1;
            return none;
          },
        },
      },
    });

    const result = await run(concealed, {
      kind: "collection",
      collection: "items",
      operation,
      id: "i1",
      input: { value: 1 as unknown as string },
    });

    expect(result.settlement).toMatchObject({
      outcome: "failed",
      failure: { kind: "mapped", value: { code: "NOT_FOUND", status: 404 } },
    });
    expect(policyCalls).toBe(1);
    await expect(storage.get("items", "i1")).resolves.toMatchObject({ value: "hello" });
  },
);

test("unknown action settles through toFailure without throwing", async () => {
  const { adapters } = await createAdapters();
  const failed = await run(adapters, {
    kind: "action",
    scope: "$",
    name: "ghost",
  });
  expect(failed.settlement).toMatchObject({
    outcome: "failed",
    stage: "classify",
    failure: {
      kind: "mapped",
      value: { code: "NOT_FOUND", status: 404 },
    },
  });
});
