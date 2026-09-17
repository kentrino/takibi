import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { createTakibi, fullAccess, type SnapshotRestoreReport } from "takibi";
import { MaintenanceController } from "../src/maintenance";
import { MemoryMaintenanceBackend } from "../src/maintenance-memory";
import { createDurableObjectCollectionsApi } from "../src/snapshot";
import { createSqliteDurableObjectStorage } from "@takibi/testing/sqlite-storage";
import type { TrustedCollectionsApi } from "../src/types";

const encoder = new TextEncoder();

function createFakeDurableObjectState(storage: DurableObjectStorage): DurableObjectState {
  return {
    storage,
    id: { name: "snapshot-validation" },
    getWebSockets: () => [],
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  } as unknown as DurableObjectState;
}

function createSnapshotObject() {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({ email: z.string().email(), score: z.number() }),
        accessPolicy: fullAccess,
        unique: { byEmail: ["email"] },
        indexes: { byScore: ["score"] },
      },
    })
    .actions({});
  return new handler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
}

type SnapshotRecord = Record<string, unknown>;

function decodeSnapshot(value: string): SnapshotRecord[] {
  return value
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as SnapshotRecord);
}

function encodeValidSnapshot(records: SnapshotRecord[]): string {
  const body = records.slice(0, -1);
  const checksum = sha256.create();
  const lines = body.map((record) => `${JSON.stringify(record)}\n`);
  for (const line of lines) checksum.update(encoder.encode(line));
  const trailer = records.at(-1)!;
  trailer.sha256 = bytesToHex(checksum.digest());
  return `${lines.join("")}${JSON.stringify(trailer)}\n`;
}

async function restore(
  object: {
    $collections: {
      $restoreSnapshot(source: ReadableStream<Uint8Array>): Promise<SnapshotRestoreReport>;
    };
  },
  encoded: string,
) {
  return object.$collections.$restoreSnapshot(
    new Blob([encoded]).stream() as ReadableStream<Uint8Array>,
  );
}

test("restore rejects malformed or incompatible snapshots without changing live data", async () => {
  const object = createSnapshotObject();
  await object.$collections.records.add({ email: "one@example.test", score: 1 }, { id: "r1" });
  const original = await new Response(await object.$collections.$exportSnapshot()).text();
  await object.$collections.records.add({ email: "live@example.test", score: 2 }, { id: "live" });

  const cases: Array<{
    code: string;
    mutate(records: SnapshotRecord[]): string;
  }> = [
    {
      code: "SNAPSHOT_INCOMPATIBLE",
      mutate(records) {
        const header = records[0]!;
        (header.collections as SnapshotRecord[]).push({ name: "unknown", schemaVersion: 0 });
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        const document = records[1]!;
        records.splice(2, 0, structuredClone(document));
        (records.at(-1)!.counts as SnapshotRecord).records = 2;
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_INVALID_DOCUMENT",
      mutate(records) {
        records[1]!.revision = 0;
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_INVALID_DOCUMENT",
      mutate(records) {
        records[1]!.createdAt = "not-a-timestamp";
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_INVALID_DOCUMENT",
      mutate(records) {
        records[1]!.data = { email: "invalid", score: 1 };
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        const outOfOrder = structuredClone(records[1]!);
        outOfOrder.id = "a";
        outOfOrder.data = { email: "a@example.test", score: 2 };
        records.splice(2, 0, outOfOrder);
        (records.at(-1)!.counts as SnapshotRecord).records = 2;
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_INCOMPATIBLE",
      mutate(records) {
        const manifest = records[0]!.collections as SnapshotRecord[];
        manifest[0]!.schemaVersion = 1;
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_INVALID_DOCUMENT",
      mutate(records) {
        const duplicate = structuredClone(records[1]!);
        duplicate.id = "r2";
        records.splice(2, 0, duplicate);
        (records.at(-1)!.counts as SnapshotRecord).records = 2;
        return encodeValidSnapshot(records);
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        (records.at(-1)!.counts as SnapshotRecord).records = 9;
        return records.map((record) => `${JSON.stringify(record)}\n`).join("");
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        records.at(-1)!.sha256 = "0".repeat(64);
        return records.map((record) => `${JSON.stringify(record)}\n`).join("");
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        return records
          .slice(0, -1)
          .map((record) => `${JSON.stringify(record)}\n`)
          .join("");
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        return `${encodeValidSnapshot(records)}${JSON.stringify(records[1])}\n`;
      },
    },
    {
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        return encodeValidSnapshot(records).replaceAll("\n", "\r\n");
      },
    },
  ];

  for (const entry of cases) {
    await expect(restore(object, entry.mutate(decodeSnapshot(original)))).rejects.toMatchObject({
      code: entry.code,
    });
    await expect(object.$collections.records.get("live")).resolves.toMatchObject({
      email: "live@example.test",
    });
  }
});

test("restore bounds an unterminated NDJSON record", async () => {
  const object = createSnapshotObject();
  await object.$collections.records.add({ email: "live@example.test", score: 1 }, { id: "live" });

  await expect(restore(object, `${"x".repeat(1024 * 1024)}\n`)).rejects.toMatchObject({
    code: "SNAPSHOT_FORMAT",
  });
  await expect(object.$collections.records.get("live")).resolves.toBeDefined();
});

test("restore rejects invalid UTF-8 without changing live data", async () => {
  const object = createSnapshotObject();
  await object.$collections.records.add({ email: "live@example.test", score: 1 }, { id: "live" });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]));
      controller.close();
    },
  });

  await expect(object.$collections.$restoreSnapshot(source)).rejects.toMatchObject({
    code: "SNAPSHOT_FORMAT",
  });
  await expect(object.$collections.records.get("live")).resolves.toBeDefined();
});

test("restore materializes old versions before indexed reads and initializes newer collections", async () => {
  const oldContext = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const oldHandler = oldContext
    .defineCollections({
      records: {
        schema: z.object({ title: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const oldObject = new oldHandler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await oldObject.$collections.records.add({ title: "Legacy" }, { id: "legacy" });
  await oldObject.$collections.records.update("legacy", { title: "Migrated", rev: 1 });
  const encoded = await new Response(await oldObject.$collections.$exportSnapshot()).text();

  const newContext = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const newHandler = newContext
    .defineCollections({
      records: {
        schema: z.object({ slug: z.string() }),
        migrations: {
          steps: [
            (data: unknown) => ({
              slug: (data as { title: string }).title.toLowerCase(),
            }),
          ],
        },
        accessPolicy: fullAccess,
        indexes: { bySlug: ["slug"] },
      },
      addedLater: {
        schema: z.object({ label: z.string() }),
        accessPolicy: fullAccess,
        seed: () => ({ seed: { label: "current seed" } }),
      },
    })
    .actions({});
  const backing = createSqliteDurableObjectStorage();
  const newObject = new newHandler.DurableObject(createFakeDurableObjectState(backing), {});
  await newObject.$collections.addedLater.add({ label: "removed" }, { id: "temporary" });

  await expect(restore(newObject, encoded)).resolves.toMatchObject({
    documentsRestored: 1,
    seedsInserted: 1,
    collections: {
      records: { documentsRestored: 1, seedsInserted: 0 },
      addedLater: { documentsRestored: 0, seedsInserted: 1 },
    },
  });
  await expect(
    newObject.$collections.records.list({
      index: "bySlug",
      where: (query) => query.slug.eq("migrated"),
    }),
  ).resolves.toMatchObject({ items: [{ id: "legacy" }] });
  expect(
    backing.sql
      .exec<{ schema_version: number; revision: number }>(
        `SELECT schema_version, revision
         FROM takibi_documents
         WHERE collection = ? AND id = ?`,
        "records",
        "legacy",
      )
      .one(),
  ).toEqual({ schema_version: 1, revision: 2 });
  await expect(newObject.$collections.records.get("legacy")).resolves.toMatchObject({
    slug: "migrated",
    rev: 2,
  });
  await expect(
    newObject.$collections.records.list({
      index: "bySlug",
      where: (query) => query.slug.eq("migrated"),
    }),
  ).resolves.toMatchObject({ items: [{ id: "legacy" }] });
  await expect(
    newObject.$collections.records.update("legacy", { slug: "continued", rev: 2 }),
  ).resolves.toMatchObject({ slug: "continued", rev: 3 });
  await expect(newObject.$collections.addedLater.listAll()).resolves.toMatchObject([
    { id: "seed", label: "current seed" },
  ]);
});

test("restore rejects a snapshot version below the current migration base", async () => {
  const oldContext = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const oldHandler = oldContext
    .defineCollections({
      records: {
        schema: z.object({ value: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const oldObject = new oldHandler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await oldObject.$collections.records.add({ value: "old" }, { id: "old" });
  const encoded = await new Response(await oldObject.$collections.$exportSnapshot()).text();

  const newContext = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const newHandler = newContext
    .defineCollections({
      records: {
        schema: z.object({ value: z.string() }),
        migrations: { base: 1, steps: [] },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const newObject = new newHandler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await newObject.$collections.records.add({ value: "live" }, { id: "live" });

  await expect(restore(newObject, encoded)).rejects.toMatchObject({
    code: "SNAPSHOT_INCOMPATIBLE",
  });
  await expect(newObject.$collections.records.get("live")).resolves.toBeDefined();
});

test("export fails instead of omitting stored data from an unregistered collection", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({ value: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const backing = createSqliteDurableObjectStorage();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.records.add({ value: "known" }, { id: "known" });
  backing.sql.exec(
    `INSERT INTO takibi_documents
       (collection, id, created_at, updated_at, schema_version, revision, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    "unknown",
    "hidden",
    "2026-08-31T00:00:00.000Z",
    "2026-08-31T00:00:00.000Z",
    0,
    1,
    '{"value":"must not be omitted"}',
  );

  await expect(
    new Response(await object.$collections.$exportSnapshot()).text(),
  ).rejects.toMatchObject({
    code: "SNAPSHOT_INCOMPATIBLE",
  });
  await expect(object.$collections.records.get("known")).resolves.toBeDefined();
});

test("export reads bounded pages only as the consumer pulls", async () => {
  const context = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const handler = context
    .defineCollections({
      records: {
        schema: z.object({ value: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const backing = createSqliteDurableObjectStorage();
  const object = new handler.DurableObject(createFakeDurableObjectState(backing), {});
  await object.$collections.records.list();
  backing.transactionSync(() => {
    for (let index = 0; index < 300; index += 1) {
      const id = index.toString().padStart(3, "0");
      backing.sql.exec(
        `INSERT INTO takibi_documents
           (collection, id, created_at, updated_at, schema_version, revision, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "records",
        id,
        "2026-08-31T00:00:00.000Z",
        "2026-08-31T00:00:00.000Z",
        0,
        1,
        JSON.stringify({ value: id }),
      );
    }
  });
  const exec = backing.sql.exec.bind(backing.sql);
  const scanLimits: unknown[] = [];
  backing.sql.exec = ((query: string, ...bindings: never[]) => {
    if (query.includes("ORDER BY collection ASC, id ASC")) {
      scanLimits.push(bindings.at(-1));
    }
    return exec(query, ...bindings);
  }) as DurableObjectStorage["sql"]["exec"];

  const reader = (await object.$collections.$exportSnapshot()).getReader();
  await reader.read();
  await reader.read();

  expect(scanLimits).toEqual([128]);
  await reader.cancel();
});

test("restore cancels its source after outer validation rejects a record", async () => {
  const object = createSnapshotObject();
  await object.$collections.records.add({ email: "one@example.test", score: 1 }, { id: "r1" });
  const records = decodeSnapshot(
    await new Response(await object.$collections.$exportSnapshot()).text(),
  );
  records[1]!.revision = 0;
  const lines = encodeValidSnapshot(records)
    .trimEnd()
    .split("\n")
    .map((line) => encoder.encode(`${line}\n`));
  let index = 0;
  let canceled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(lines[index++]!);
      if (index === lines.length) controller.close();
    },
    cancel() {
      canceled = true;
    },
  });

  await expect(object.$collections.$restoreSnapshot(source)).rejects.toMatchObject({
    code: "SNAPSHOT_INVALID_DOCUMENT",
  });
  expect(canceled).toBe(true);
});

test("restore keeps normal operations locked while its source is stalled", async () => {
  const object = createSnapshotObject();
  await object.$collections.records.add({ email: "one@example.test", score: 1 }, { id: "r1" });
  const encoded = await new Response(await object.$collections.$exportSnapshot()).text();
  const lines = encoded
    .trimEnd()
    .split("\n")
    .map((line) => encoder.encode(`${line}\n`));
  let index = 0;
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === 0) {
        controller.enqueue(lines[index++]!);
        return;
      }
      entered();
      await releasePromise;
      while (index < lines.length) controller.enqueue(lines[index++]!);
      controller.close();
    },
  });

  const restoration = object.$collections.$restoreSnapshot(source);
  await enteredPromise;
  await expect(object.$collections.records.get("r1")).rejects.toMatchObject({
    code: "MAINTENANCE_LOCKED",
  });
  release();
  await expect(restoration).resolves.toMatchObject({ documentsRestored: 1 });
  await expect(object.$collections.records.get("r1")).resolves.toBeDefined();
});

test("restore errors and logs never include secret-bearing migration input", async () => {
  const secret = "snapshot-secret-value";
  const oldContext = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
  });
  const oldHandler = oldContext
    .defineCollections({
      records: {
        schema: z.object({ secret: z.string() }),
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const oldObject = new oldHandler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );
  await oldObject.$collections.records.add({ secret }, { id: "secret" });
  const encoded = await new Response(await oldObject.$collections.$exportSnapshot()).text();

  const events: unknown[] = [];
  const newContext = createTakibi()({
    resolve: () => ({ tenantId: "snapshot-validation" }),
    logger: { log: (event) => events.push(event) },
    logLevel: "debug",
  });
  const newHandler = newContext
    .defineCollections({
      records: {
        schema: z.object({ migrated: z.string() }),
        migrations: {
          steps: [
            (data: unknown) => {
              throw new Error(`migration rejected ${JSON.stringify(data)}`);
            },
          ],
        },
        accessPolicy: fullAccess,
      },
    })
    .actions({});
  const newObject = new newHandler.DurableObject(
    createFakeDurableObjectState(createSqliteDurableObjectStorage()),
    {},
  );

  let failure: unknown;
  try {
    await restore(newObject, encoded);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "SNAPSHOT_INVALID_DOCUMENT" });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(secret);
});

test("memory maintenance backend round-trips logical snapshot metadata", async () => {
  const collections = {
    records: {
      schema: z.object({ value: z.string() }),
      accessPolicy: fullAccess,
    },
  } as const;
  const sourceBackend = new MemoryMaintenanceBackend();
  sourceBackend.writeLive({
    collection: "records",
    id: "r1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 7,
    data: { value: "memory" },
  });
  const sourceApi = createDurableObjectCollectionsApi(
    {} as TrustedCollectionsApi<typeof collections>,
    collections,
    new MaintenanceController(sourceBackend),
    Promise.resolve(),
  );
  const encoded = await new Response(await sourceApi.$exportSnapshot()).text();

  const targetBackend = new MemoryMaintenanceBackend();
  targetBackend.writeLive({
    collection: "records",
    id: "obsolete",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 1,
    data: { value: "removed" },
  });
  const targetApi = createDurableObjectCollectionsApi(
    {} as TrustedCollectionsApi<typeof collections>,
    collections,
    new MaintenanceController(targetBackend),
    Promise.resolve(),
  );

  await expect(restore({ $collections: targetApi }, encoded)).resolves.toMatchObject({
    documentsRestored: 1,
  });
  expect(targetBackend.readLive("records", "r1")).toEqual({
    collection: "records",
    id: "r1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 7,
    data: { value: "memory" },
  });
  expect(targetBackend.readLive("records", "obsolete")).toBeUndefined();
});

test("memory maintenance backend scans ordered bounded pages", async () => {
  const backend = new MemoryMaintenanceBackend();
  for (let index = 299; index >= 0; index -= 1) {
    const id = index.toString().padStart(3, "0");
    backend.writeLive({
      collection: "records",
      id,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      schemaVersion: 0,
      revision: 1,
      data: { value: id },
    });
  }

  const first = await backend.scanDocuments(undefined, 128);
  const second = await backend.scanDocuments({ collection: "records", id: first.at(-1)!.id }, 128);

  expect(first).toHaveLength(128);
  expect(first[0]!.id).toBe("000");
  expect(first.at(-1)!.id).toBe("127");
  expect(second).toHaveLength(128);
  expect(second[0]!.id).toBe("128");
  expect(second.at(-1)!.id).toBe("255");
});
