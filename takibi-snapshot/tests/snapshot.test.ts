import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test } from "vite-plus/test";
import type { TrustedCollectionsApi } from "@takibi/takibi-api";
import type { SnapshotRestoreReport } from "@takibi/takibi-shared-types";
import {
  attachSnapshotOperations,
  MaintenanceController,
  MemoryMaintenanceBackend,
  type SnapshotLifecycle,
  type SnapshotStoredDocument,
} from "../src";

const encoder = new TextEncoder();

type SnapshotRecord = Record<string, unknown>;

const passThroughLifecycle: SnapshotLifecycle = {
  listCollections() {
    return [{ name: "records", currentSchemaVersion: 0, baseSchemaVersion: 0 }];
  },
  async validateRestoredDocument() {
    return [];
  },
  async prepareSeeds() {
    return [];
  },
};

function createSnapshotApi(
  backend: MemoryMaintenanceBackend,
  lifecycle: SnapshotLifecycle = passThroughLifecycle,
) {
  return attachSnapshotOperations(
    {} as TrustedCollectionsApi<{ records: never }>,
    new MaintenanceController(backend),
    Promise.resolve(),
    lifecycle,
  );
}

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
  api: {
    $restoreSnapshot(source: ReadableStream<Uint8Array>): Promise<SnapshotRestoreReport>;
  },
  encoded: string,
) {
  return api.$restoreSnapshot(new Blob([encoded]).stream() as ReadableStream<Uint8Array>);
}

function liveDocument(overrides: Partial<SnapshotStoredDocument> = {}): SnapshotStoredDocument {
  return {
    collection: "records",
    id: "r1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    schemaVersion: 0,
    revision: 7,
    data: { value: "memory" },
    ...overrides,
  };
}

test("memory maintenance backend round-trips logical snapshot metadata", async () => {
  const sourceBackend = new MemoryMaintenanceBackend();
  sourceBackend.writeLive(liveDocument());
  const sourceApi = createSnapshotApi(sourceBackend);
  const encoded = await new Response(await sourceApi.$exportSnapshot()).text();
  const records = decodeSnapshot(encoded);

  expect(records[0]).toMatchObject({
    type: "header",
    format: "takibi.logical-snapshot",
    version: 1,
    collections: [{ name: "records", schemaVersion: 0 }],
  });
  expect(records[1]).toMatchObject({
    type: "document",
    collection: "records",
    id: "r1",
    revision: 7,
    data: { value: "memory" },
  });
  expect(records.at(-1)).toMatchObject({
    type: "trailer",
    counts: { records: 1 },
  });

  const targetBackend = new MemoryMaintenanceBackend();
  targetBackend.writeLive(
    liveDocument({
      id: "obsolete",
      revision: 1,
      data: { value: "removed" },
    }),
  );
  const targetApi = createSnapshotApi(targetBackend);

  await expect(restore(targetApi, encoded)).resolves.toMatchObject({
    documentsRestored: 1,
    seedsInserted: 0,
    collections: { records: { documentsRestored: 1, seedsInserted: 0 } },
  });
  expect(targetBackend.readLive("records", "r1")).toEqual(liveDocument());
  expect(targetBackend.readLive("records", "obsolete")).toBeUndefined();
});

test("memory maintenance backend scans ordered bounded pages", async () => {
  const backend = new MemoryMaintenanceBackend();
  for (let index = 299; index >= 0; index -= 1) {
    const id = index.toString().padStart(3, "0");
    backend.writeLive(liveDocument({ id, revision: 1, data: { value: id } }));
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

test("restore rejects malformed or incompatible snapshots without changing live data", async () => {
  const backend = new MemoryMaintenanceBackend();
  backend.writeLive(liveDocument({ id: "live", revision: 1, data: { value: "live" } }));
  const api = createSnapshotApi(backend);
  const original = await new Response(await api.$exportSnapshot()).text();

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
      code: "SNAPSHOT_FORMAT",
      mutate(records) {
        const outOfOrder = structuredClone(records[1]!);
        outOfOrder.id = "a";
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
    {
      code: "SNAPSHOT_INVALID_DOCUMENT",
      mutate(records) {
        (records[1]!.data as SnapshotRecord).id = "reserved";
        return encodeValidSnapshot(records);
      },
    },
  ];

  for (const entry of cases) {
    await expect(restore(api, entry.mutate(decodeSnapshot(original)))).rejects.toMatchObject({
      code: entry.code,
    });
    expect(backend.readLive("records", "live")).toMatchObject({ data: { value: "live" } });
  }
});

test("restore bounds an unterminated NDJSON record", async () => {
  const backend = new MemoryMaintenanceBackend();
  backend.writeLive(liveDocument({ id: "live", revision: 1, data: { value: "live" } }));
  const api = createSnapshotApi(backend);

  await expect(restore(api, `${"x".repeat(1024 * 1024)}\n`)).rejects.toMatchObject({
    code: "SNAPSHOT_FORMAT",
  });
  expect(backend.readLive("records", "live")).toBeDefined();
});

test("restore rejects invalid UTF-8, BOM, and truncated streams without changing live data", async () => {
  const backend = new MemoryMaintenanceBackend();
  backend.writeLive(liveDocument({ id: "live", revision: 1, data: { value: "live" } }));
  const api = createSnapshotApi(backend);

  await expect(
    api.$restoreSnapshot(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]));
          controller.close();
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "SNAPSHOT_FORMAT" });

  await expect(
    api.$restoreSnapshot(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]));
          controller.close();
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "SNAPSHOT_FORMAT" });

  await expect(
    api.$restoreSnapshot(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"header"'));
          controller.close();
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "SNAPSHOT_FORMAT" });

  expect(backend.readLive("records", "live")).toBeDefined();
});

test("restore cancels its source after outer validation rejects a record", async () => {
  const backend = new MemoryMaintenanceBackend();
  backend.writeLive(liveDocument({ id: "r1", revision: 1, data: { value: "one" } }));
  const api = createSnapshotApi(backend);
  const records = decodeSnapshot(await new Response(await api.$exportSnapshot()).text());
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

  await expect(api.$restoreSnapshot(source)).rejects.toMatchObject({
    code: "SNAPSHOT_INVALID_DOCUMENT",
  });
  expect(canceled).toBe(true);
});

test("export fails instead of omitting stored data from an unregistered collection", async () => {
  const backend = new MemoryMaintenanceBackend();
  backend.writeLive(liveDocument({ collection: "unknown", id: "hidden", revision: 1 }));
  const api = createSnapshotApi(backend);

  await expect(new Response(await api.$exportSnapshot()).text()).rejects.toMatchObject({
    code: "SNAPSHOT_INCOMPATIBLE",
  });
});

test("reset replaces live documents with prepared seeds", async () => {
  const backend = new MemoryMaintenanceBackend();
  backend.writeLive(liveDocument({ id: "obsolete", revision: 1, data: { value: "gone" } }));
  const seed = liveDocument({ id: "seed", revision: 1, data: { value: "seeded" } });
  const api = createSnapshotApi(backend, {
    ...passThroughLifecycle,
    async prepareSeeds() {
      return [{ document: seed, uniqueConstraints: [] }];
    },
  });

  await api.$resetAll();
  expect(backend.readLive("records", "obsolete")).toBeUndefined();
  expect(backend.readLive("records", "seed")).toEqual(seed);
});

test("restore inserts missing seeds and keeps snapshot documents on ID collision", async () => {
  const backend = new MemoryMaintenanceBackend();
  const snapshotDocument = liveDocument({
    id: "shared",
    revision: 3,
    data: { value: "from-snapshot" },
  });
  const source = new MemoryMaintenanceBackend();
  source.writeLive(snapshotDocument);
  const encoded = await new Response(await createSnapshotApi(source).$exportSnapshot()).text();

  const collidingSeed = liveDocument({ id: "shared", revision: 1, data: { value: "from-seed" } });
  const extraSeed = liveDocument({ id: "seed", revision: 1, data: { value: "extra" } });
  const api = createSnapshotApi(backend, {
    ...passThroughLifecycle,
    async prepareSeeds() {
      return [
        { document: collidingSeed, uniqueConstraints: [] },
        { document: extraSeed, uniqueConstraints: [] },
      ];
    },
  });

  await expect(restore(api, encoded)).resolves.toMatchObject({
    documentsRestored: 1,
    seedsInserted: 1,
    collections: { records: { documentsRestored: 1, seedsInserted: 1 } },
  });
  expect(backend.readLive("records", "shared")).toEqual(snapshotDocument);
  expect(backend.readLive("records", "seed")).toEqual(extraSeed);
});
