import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess } from "takibi";
import { createMigratingStorage } from "../src/migrations";
import { createDurableObjectStorage } from "../src/storage";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import type { AccessContext, CollectionsDef, StorageDriver } from "../src/types";
import type { WireRequest, WireResponse } from "../src/protocol";

const CREATED_AT = "2026-08-01T00:00:00.000Z";
const UPDATED_AT = "2026-08-02T00:00:00.000Z";
type WithoutContext<T> = T extends unknown ? Omit<T, "context"> : never;
type WireInvocation = WithoutContext<WireRequest>;

type StoredDocument = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  rev?: number;
};

function createInspectableDurableObjectStorage() {
  const storage = createSqliteDurableObjectStorage();
  const driver = createDurableObjectStorage(storage);

  return {
    storage,
    async seed(collection: string, document: StoredDocument): Promise<void> {
      await driver.put(collection, document as import("../src/types").StoredDocument);
    },
    async read(collection: string, id: string): Promise<StoredDocument | undefined> {
      return (await driver.get(collection, id)) ?? undefined;
    },
  };
}

function createState(storage: DurableObjectStorage): DurableObjectState {
  return {
    storage,
    id: {},
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

async function invoke(object: DurableObject, invocation: WireInvocation) {
  const response = await object.fetch(
    new Request("https://takibi.internal", {
      method: "POST",
      body: JSON.stringify({
        ...invocation,
        context: { tenantId: "tenant-a" },
      } satisfies WireRequest),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as WireResponse,
  };
}

function legacy(id: string, data: Record<string, unknown>): StoredDocument {
  return { ...data, id, createdAt: CREATED_AT, updatedAt: UPDATED_AT };
}

function migratingPostsDefinition() {
  return {
    schema: z.object({ title: z.string(), published: z.boolean() }),
    migrations: {
      steps: [
        (data: unknown) => ({
          ...(data as { title: string }),
          published: true,
        }),
      ] as const,
    },
    accessPolicy: fullAccess,
  };
}

function gateBeforeFirstTransaction(raw: StorageDriver): {
  storage: StorageDriver;
  entered: Promise<void>;
  release: () => void;
} {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercept = true;
  return {
    storage: {
      ...raw,
      transaction(callback) {
        if (!intercept) return raw.transaction(callback);
        intercept = false;
        enter();
        return released.then(() => raw.transaction(callback));
      },
    },
    entered,
    release,
  };
}

test("missing markers migrate in order once, validate, write back, and stay private", async () => {
  const stepInputs: unknown[] = [];
  const policyDocs: unknown[] = [];
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const handler = context
    .defineCollections({
      settings: {
        schema: z.object({ label: z.string(), enabled: z.boolean() }),
        migrations: {
          steps: [
            (data) => {
              stepInputs.push(structuredClone(data));
              return { ...(data as { name: string }), label: (data as { name: string }).name };
            },
            (data) => {
              stepInputs.push(structuredClone(data));
              const { name: _name, ...rest } = data as { name: string; label: string };
              return { ...rest, enabled: true };
            },
          ],
        },
        accessPolicy(ctx) {
          policyDocs.push(structuredClone(ctx.doc));
          return fullAccess;
        },
      },
    })
    .actions({});
  const backing = createInspectableDurableObjectStorage();
  await backing.seed("settings", legacy("default", { name: "Clinic" }));
  const object = new handler.DurableObject(createState(backing.storage), {});

  const first = await invoke(object, {
    kind: "collection",
    collection: "settings",
    operation: "get",
    id: "default",
  });
  expect(first).toMatchObject({
    status: 200,
    body: {
      ok: true,
      data: {
        id: "default",
        label: "Clinic",
        enabled: true,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
      },
    },
  });
  expect(first.body).not.toHaveProperty("data.$schemaVersion");
  expect(policyDocs).toEqual([
    {
      id: "default",
      label: "Clinic",
      enabled: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      rev: 1,
    },
  ]);
  expect(stepInputs).toEqual([{ name: "Clinic" }, { name: "Clinic", label: "Clinic" }]);
  expect(await backing.read("settings", "default")).toEqual({
    id: "default",
    label: "Clinic",
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    rev: 1,
    $schemaVersion: 2,
  });

  await invoke(object, {
    kind: "collection",
    collection: "settings",
    operation: "get",
    id: "default",
  });
  expect(stepInputs).toHaveLength(2);
});

test("list migrates each scanned document before current-schema filtering", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const handler = context
    .defineCollections({
      posts: {
        schema: z.object({ slug: z.string(), published: z.boolean() }),
        migrations: {
          steps: [
            (data) => ({
              slug: (data as { title: string }).title.toLowerCase(),
              published: (data as { visible: boolean }).visible,
            }),
          ],
        },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const backing = createInspectableDurableObjectStorage();
  await backing.seed("posts", legacy("a", { title: "MATCH", visible: true }));
  await backing.seed("posts", legacy("b", { title: "OTHER", visible: false }));
  const object = new handler.DurableObject(createState(backing.storage), {});

  const result = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { where: { field: "slug", op: "eq", value: "match" } },
  });

  expect(result).toMatchObject({
    status: 200,
    body: { ok: true, data: { items: [{ id: "a", slug: "match", published: true }] } },
  });
  expect(await backing.read("posts", "a")).toMatchObject({ slug: "match", $schemaVersion: 1 });
  expect(await backing.read("posts", "b")).toMatchObject({ slug: "other", $schemaVersion: 1 });
});

test("unique constraints compare current-schema values during lazy migration", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const handler = context
    .defineCollections({
      posts: {
        schema: z.object({ slug: z.string() }),
        migrations: {
          steps: [
            (data) => ({
              slug: (data as { title: string }).title.trim().toLowerCase(),
            }),
          ],
        },
        unique: { bySlug: ["slug"] },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const backing = createInspectableDurableObjectStorage();
  await backing.seed("posts", legacy("a", { title: " Same " }));
  await backing.seed("posts", legacy("b", { title: "same" }));
  const object = new handler.DurableObject(createState(backing.storage), {});

  const result = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "get",
    id: "a",
  });

  expect(result).toMatchObject({
    status: 409,
    body: {
      ok: false,
      error: {
        code: "ALREADY_EXISTS",
        message: "Unique constraint violated: posts.bySlug",
      },
    },
  });
  expect(await backing.read("posts", "a")).toMatchObject({ title: " Same " });
  expect(await backing.read("posts", "b")).toMatchObject({ title: "same" });
});

test("unique constraints reject current-schema duplicates in Durable Object storage", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const handler = context
    .defineCollections({
      posts: {
        schema: z.object({ slug: z.string() }),
        unique: { bySlug: ["slug"] },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const backing = createInspectableDurableObjectStorage();
  const object = new handler.DurableObject(createState(backing.storage), {});

  const first = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "a",
    input: { slug: "same" },
  });
  const duplicate = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "b",
    input: { slug: "same" },
  });

  expect(first).toMatchObject({ status: 200, body: { ok: true } });
  expect(duplicate).toMatchObject({
    status: 409,
    body: {
      ok: false,
      error: {
        code: "ALREADY_EXISTS",
        message: "Unique constraint violated: posts.bySlug",
      },
    },
  });
  expect(await backing.read("posts", "b")).toBeUndefined();
});

test("get, set, update, and delete policies only see migrated existing documents", async () => {
  for (const operation of ["get", "set", "update", "delete"] as const) {
    const observed: unknown[] = [];
    const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
    const handler = context
      .defineCollections({
        posts: {
          schema: z.object({ title: z.string(), published: z.boolean() }),
          migrations: {
            steps: [
              (data) => ({
                ...(data as { title: string }),
                published: true,
              }),
            ],
          },
          accessPolicy(ctx: AccessContext<{ tenantId: string }>) {
            observed.push(structuredClone(ctx.doc));
            return fullAccess;
          },
        },
      })
      .actions({});
    const backing = createInspectableDurableObjectStorage();
    await backing.seed("posts", legacy("p1", { title: "old" }));
    const object = new handler.DurableObject(createState(backing.storage), {});
    const input =
      operation === "set"
        ? { title: "set", published: false }
        : operation === "update"
          ? { title: "updated" }
          : undefined;

    const result = await invoke(object, {
      kind: "collection",
      collection: "posts",
      operation,
      id: "p1",
      ...(input === undefined ? {} : { input }),
    });

    expect(result.status).toBe(200);
    expect(observed).toEqual([
      {
        id: "p1",
        title: "old",
        published: true,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        rev: 1,
      },
    ]);
  }
});

test("migration throw, validation failure, and versions below base leave storage unchanged", async () => {
  const cases = [
    {
      migrations: {
        steps: [
          () => {
            throw new Error("cannot migrate");
          },
        ],
      },
    },
    {
      migrations: {
        steps: [() => ({ count: "invalid" }) as unknown as { count: number }],
      },
    },
    {
      migrations: {
        base: 1,
        steps: [(data: unknown) => data as { count: number }],
      },
    },
  ] as const;

  for (const [index, definition] of cases.entries()) {
    const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
    const handler = context
      .defineCollections({
        counters: {
          schema: z.object({ count: z.number() }),
          migrations: definition.migrations,
          accessPolicy: fullAccess,
        },
      })
      .actions({});
    const backing = createInspectableDurableObjectStorage();
    const original = legacy(`c${index}`, { count: 1 });
    await backing.seed("counters", original);
    const object = new handler.DurableObject(createState(backing.storage), {});

    const result = await invoke(object, {
      kind: "collection",
      collection: "counters",
      operation: "get",
      id: `c${index}`,
    });

    expect(result.body).toMatchObject({ ok: false });
    expect(await backing.read("counters", `c${index}`)).toEqual({ ...original, rev: 1 });
  }
});

test("new writes persist the current marker but reject marker input and marker queries", async () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  const handler = context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        migrations: { base: 2, steps: [(data) => data as { title: string }] },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const backing = createInspectableDurableObjectStorage();
  const object = new handler.DurableObject(createState(backing.storage), {});

  const add = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "p1",
    input: { title: "new" },
  });
  expect(add).toMatchObject({ status: 200, body: { ok: true, data: { title: "new" } } });
  expect(add.body).not.toHaveProperty("data.$schemaVersion");
  expect(await backing.read("posts", "p1")).toMatchObject({ title: "new", $schemaVersion: 3 });

  const reservedInput = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "p2",
    input: { title: "bad", $schemaVersion: 3 },
  });
  expect(reservedInput).toMatchObject({
    status: 400,
    body: { ok: false, error: { kind: "validation", code: "VALIDATION" } },
  });
  expect(await backing.read("posts", "p2")).toBeUndefined();

  const reservedQuery = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { where: { field: "$schemaVersion", op: "eq", value: 3 } },
  });
  expect(reservedQuery).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "BAD_REQUEST" } },
  });

  const reservedRevInput = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "add",
    id: "p3",
    input: { title: "bad", rev: 1 },
  });
  expect(reservedRevInput).toMatchObject({
    status: 400,
    body: { ok: false, error: { kind: "validation", code: "VALIDATION" } },
  });

  const reservedRevQuery = await invoke(object, {
    kind: "collection",
    collection: "posts",
    operation: "list",
    list: { where: { field: "rev", op: "eq", value: 1 } },
  });
  expect(reservedRevQuery).toMatchObject({
    status: 400,
    body: { ok: false, error: { code: "BAD_REQUEST" } },
  });
});

test("collection registration rejects migration bases that are not non-negative integers", () => {
  const context = createTakibi()({ resolve: () => ({ tenantId: "tenant-a" }) });
  for (const base of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      context.defineCollections({
        posts: {
          schema: z.object({ title: z.string() }),
          migrations: { base, steps: [] },
          accessPolicy: fullAccess,
        },
      }),
    ).toThrow(/base.*non-negative integer/i);
  }
});

test("SQLite storage applies lazy migration semantics", async () => {
  const durableBacking = createInspectableDurableObjectStorage();
  const raw = createDurableObjectStorage(durableBacking.storage);
  const definition = {
    schema: z.object({ title: z.string(), published: z.boolean() }),
    migrations: {
      steps: [
        (data: unknown) => ({
          ...(data as { title: string }),
          published: true,
        }),
      ] as const,
    },
    accessPolicy: fullAccess,
  };

  await raw.put("posts", legacy("p1", { title: "old" }) as import("../src/types").StoredDocument);
  const storage = createMigratingStorage({ posts: definition }, raw);

  await expect(storage.get("posts", "p1")).resolves.toEqual({
    id: "p1",
    title: "old",
    published: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    rev: 1,
  });
  await expect(raw.get("posts", "p1")).resolves.toMatchObject({
    title: "old",
    published: true,
    $schemaVersion: 1,
  });
});

test("lazy migration rechecks its source before replacing a concurrently updated row", async () => {
  const durableBacking = createInspectableDurableObjectStorage();
  const raw = createDurableObjectStorage(durableBacking.storage);
  const definition = {
    schema: z.object({ title: z.string(), published: z.boolean() }),
    migrations: {
      steps: [
        (data: unknown) => ({
          ...(data as { title: string }),
          published: true,
        }),
      ] as const,
    },
    accessPolicy: fullAccess,
  };
  await raw.put("posts", legacy("p1", { title: "old" }) as import("../src/types").StoredDocument);

  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let interceptInitialRead = true;
  const interleaved: StorageDriver = {
    ...raw,
    async get(collection, id) {
      const document = await raw.get(collection, id);
      if (interceptInitialRead) {
        interceptInitialRead = false;
        enter();
        await released;
      }
      return document;
    },
  };
  const migrating = createMigratingStorage({ posts: definition }, interleaved);
  const migration = migrating.get("posts", "p1");
  await entered;
  await raw.put("posts", {
    ...legacy("p1", { title: "new" }),
    rev: 2,
  } as import("../src/types").StoredDocument);
  release();

  await expect(migration).resolves.toMatchObject({ title: "new", published: true, rev: 2 });
  await expect(raw.get("posts", "p1")).resolves.toMatchObject({
    title: "new",
    published: true,
    rev: 2,
    $schemaVersion: 1,
  });
});

test("lazy migration get returns null when the source row disappears", async () => {
  const raw = createDurableObjectStorage(createInspectableDurableObjectStorage().storage);
  await raw.put("posts", legacy("p1", { title: "old" }) as import("../src/types").StoredDocument);
  const { storage, entered, release } = gateBeforeFirstTransaction(raw);
  const migrating = createMigratingStorage({ posts: migratingPostsDefinition() }, storage);
  const migration = migrating.get("posts", "p1");
  await entered;
  await raw.delete("posts", "p1");
  release();

  await expect(migration).resolves.toBeNull();
  await expect(raw.get("posts", "p1")).resolves.toBeNull();
});

test("lazy migration list omits a row that disappeared before persistence", async () => {
  const raw = createDurableObjectStorage(createInspectableDurableObjectStorage().storage);
  await raw.put("posts", legacy("p1", { title: "old" }) as import("../src/types").StoredDocument);
  await raw.put("posts", legacy("p2", { title: "keep" }) as import("../src/types").StoredDocument);
  const { storage, entered, release } = gateBeforeFirstTransaction(raw);
  const migrating = createMigratingStorage({ posts: migratingPostsDefinition() }, storage);
  const listing = migrating.list("posts");
  await entered;
  await raw.delete("posts", "p1");
  release();

  await expect(listing).resolves.toMatchObject({
    items: [{ id: "p2", title: "keep", published: true }],
  });
  await expect(raw.get("posts", "p1")).resolves.toBeNull();
  await expect(raw.get("posts", "p2")).resolves.toMatchObject({
    title: "keep",
    published: true,
    $schemaVersion: 1,
  });
});

test("indexed backfill migrates existing documents before the index is ready", async () => {
  const { compileIndexRegistry } = await import("../src/indexes");
  const { reconcileCollectionIndexes } = await import("../src/index-reconcile");

  const definition = {
    schema: z.object({ ownerId: z.string(), title: z.string() }),
    accessPolicy: fullAccess,
    indexes: { byOwner: ["ownerId", "createdAt"] as const },
    migrations: {
      steps: [
        (data: unknown) => ({
          ...(data as { title: string }),
          ownerId: "migrated",
        }),
      ] as const,
    },
  };
  const collections = { posts: definition };
  const registry = compileIndexRegistry(collections);
  const backing = createSqliteDurableObjectStorage();
  const durable = createDurableObjectStorage(backing, registry);
  await durable.put(
    "posts",
    legacy("p1", { title: "old" }) as import("../src/types").StoredDocument,
  );
  const migrating = createMigratingStorage(collections as unknown as CollectionsDef, durable);
  await reconcileCollectionIndexes({
    sql: backing.sql,
    collections,
    storage: migrating,
    registry,
  });
  await expect(durable.get("posts", "p1")).resolves.toMatchObject({
    ownerId: "migrated",
    $schemaVersion: 1,
  });
  const page = await durable.list("posts", {
    index: "byOwner",
    where: { field: "ownerId", op: "eq", value: "migrated" },
  });
  expect(page.items.map((document) => document.id)).toEqual(["p1"]);

  const failing = {
    posts: {
      ...definition,
      migrations: {
        steps: [
          () => {
            throw new Error("migration-failed");
          },
        ] as const,
      },
    },
  };
  const failingBacking = createSqliteDurableObjectStorage();
  const failingDurable = createDurableObjectStorage(failingBacking, compileIndexRegistry(failing));
  await failingDurable.put(
    "posts",
    legacy("p2", { title: "old" }) as import("../src/types").StoredDocument,
  );
  await expect(
    reconcileCollectionIndexes({
      sql: failingBacking.sql,
      collections: failing,
      storage: createMigratingStorage(failing as unknown as CollectionsDef, failingDurable),
      registry: compileIndexRegistry(failing),
    }),
  ).rejects.toThrow("migration-failed");
  expect(
    failingBacking.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM takibi_index_catalog")
      .one().count,
  ).toBe(0);
});
