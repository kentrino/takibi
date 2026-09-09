import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  SnapshotFormatError,
  SnapshotIncompatibleError,
  SnapshotInvalidDocumentError,
  type CollectionsDef,
  type DurableObjectCollectionsApi,
  type TrustedCollectionsApi,
} from "@takibi/takibi-api";
import {
  RESERVED_DOCUMENT_DATA_KEYS,
  type SnapshotRestoreReport,
} from "@takibi/takibi-shared-types";
import { compareUtf8 } from "@takibi/takibi-storage";
import type { LeaseHandle, MaintenanceController } from "./maintenance";
import type { SnapshotLifecycle, SnapshotStoredDocument, SnapshotUniqueConstraint } from "./types";

const SNAPSHOT_FORMAT = "takibi.logical-snapshot";
const SNAPSHOT_VERSION = 1;
const SCAN_PAGE_SIZE = 128;
const MAX_RECORD_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

type HeaderRecord = {
  type: "header";
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  collections: Array<{ name: string; schemaVersion: number }>;
};

type DocumentRecord = {
  type: "document";
  collection: string;
  id: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  revision: number;
  data: Record<string, unknown>;
};

type TrailerRecord = {
  type: "trailer";
  counts: Record<string, number>;
  sha256: string;
};

export function attachSnapshotOperations<TCollections extends CollectionsDef>(
  trusted: TrustedCollectionsApi<TCollections>,
  maintenance: MaintenanceController,
  ready: Promise<void>,
  lifecycle: SnapshotLifecycle,
): DurableObjectCollectionsApi<TCollections> {
  const operations = {
    async $exportSnapshot() {
      await ready;
      return exportSnapshot(lifecycle, maintenance);
    },
    async $restoreSnapshot(source: ReadableStream<Uint8Array>) {
      await ready;
      return restoreSnapshot(lifecycle, maintenance, source);
    },
    async $resetAll() {
      await ready;
      return resetAll(lifecycle, maintenance);
    },
  } satisfies Omit<DurableObjectCollectionsApi<Record<never, never>>, "$transaction">;
  for (const [name, value] of Object.entries(operations)) {
    Object.defineProperty(trusted, name, {
      value,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return trusted as DurableObjectCollectionsApi<TCollections>;
}

async function exportSnapshot(
  lifecycle: SnapshotLifecycle,
  maintenance: MaintenanceController,
): Promise<ReadableStream<Uint8Array>> {
  const lease = await maintenance.acquire("export");
  const manifest = collectionManifest(lifecycle);
  const known = new Set(manifest.map(({ name }) => name));
  const counts = Object.fromEntries(manifest.map(({ name }) => [name, 0])) as Record<
    string,
    number
  >;
  const checksum = sha256.create();
  let headerPending = true;
  let page: SnapshotStoredDocument[] = [];
  let pageOffset = 0;
  let cursor: { collection: string; id: string } | undefined;
  let finished = false;

  const finishWithError = async (error: unknown): Promise<never> => {
    finished = true;
    await maintenance.release(lease);
    throw error;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        if (headerPending) {
          headerPending = false;
          const bytes = encodeRecord({
            type: "header",
            format: SNAPSHOT_FORMAT,
            version: SNAPSHOT_VERSION,
            collections: manifest,
          } satisfies HeaderRecord);
          checksum.update(bytes);
          controller.enqueue(bytes);
          return;
        }

        if (pageOffset >= page.length) {
          await maintenance.renew(lease);
          page = await maintenance.backend.scanDocuments(cursor, SCAN_PAGE_SIZE);
          pageOffset = 0;
          if (page.length === 0) {
            const trailer = encodeRecord({
              type: "trailer",
              counts,
              sha256: bytesToHex(checksum.digest()),
            } satisfies TrailerRecord);
            await maintenance.release(lease);
            finished = true;
            controller.enqueue(trailer);
            controller.close();
            return;
          }
        }

        const document = page[pageOffset]!;
        pageOffset += 1;
        cursor = { collection: document.collection, id: document.id };
        if (!known.has(document.collection)) {
          throw new SnapshotIncompatibleError(
            `Stored data contains an unregistered collection: ${document.collection}`,
          );
        }
        counts[document.collection] = (counts[document.collection] ?? 0) + 1;
        const bytes = encodeRecord({
          type: "document",
          ...document,
        } satisfies DocumentRecord);
        checksum.update(bytes);
        controller.enqueue(bytes);
      } catch (error) {
        await finishWithError(error);
      }
    },
    async cancel() {
      if (finished) return;
      finished = true;
      await maintenance.release(lease);
    },
  });
}

async function restoreSnapshot(
  lifecycle: SnapshotLifecycle,
  maintenance: MaintenanceController,
  source: ReadableStream<Uint8Array>,
): Promise<SnapshotRestoreReport> {
  const lease = await maintenance.acquire("restore");
  let finalized = false;
  try {
    await maintenance.backend.clearStaging(lease.token);
    const checksum = sha256.create();
    let header: HeaderRecord | undefined;
    let trailerSeen = false;
    let previous: { collection: string; id: string } | undefined;
    const counts: Record<string, number> = {};
    const catalog = collectionCatalog(lifecycle);

    for await (const line of readSnapshotLines(source, () => maintenance.renew(lease))) {
      if (trailerSeen) throw new SnapshotFormatError("Records found after snapshot trailer");
      const value = parseRecord(line.content);
      if (header === undefined) {
        header = validateHeader(value, catalog);
        for (const { name } of header.collections) counts[name] = 0;
        checksum.update(line.encoded);
        continue;
      }
      if (isRecordWithType(value, "trailer")) {
        validateTrailer(value, header, counts, bytesToHex(checksum.digest()));
        trailerSeen = true;
        continue;
      }

      const document = validateDocumentRecord(value, header, catalog, previous);
      previous = { collection: document.collection, id: document.id };
      counts[document.collection] = (counts[document.collection] ?? 0) + 1;
      await validateAndStageDocument(lifecycle, maintenance, lease, document);
      checksum.update(line.encoded);
    }

    if (header === undefined) throw new SnapshotFormatError("Snapshot header is missing");
    if (!trailerSeen) throw new SnapshotFormatError("Snapshot trailer is missing");

    const seeds = await lifecycle.prepareSeeds();
    const seedCounts = Object.fromEntries(catalog.map(({ name }) => [name, 0])) as Record<
      string,
      number
    >;
    for (const seed of seeds) {
      const present = await maintenance.backend.hasStagedDocument(
        lease.token,
        seed.document.collection,
        seed.document.id,
      );
      if (!present) {
        await stageUniqueConstraints(maintenance, lease, seed.uniqueConstraints);
        seedCounts[seed.document.collection] = (seedCounts[seed.document.collection] ?? 0) + 1;
      }
    }

    const expectedInserted = Object.values(seedCounts).reduce((sum, count) => sum + count, 0);
    const collectionReports = Object.fromEntries(
      catalog
        .map(({ name }) => name)
        .sort(compareUtf8)
        .map((name) => [
          name,
          {
            documentsRestored: counts[name] ?? 0,
            seedsInserted: seedCounts[name] ?? 0,
          },
        ]),
    );
    const report = {
      formatVersion: SNAPSHOT_VERSION,
      documentsRestored: Object.values(counts).reduce((sum, count) => sum + count, 0),
      seedsInserted: expectedInserted,
      collections: collectionReports,
    } satisfies SnapshotRestoreReport;
    await maintenance.renew(lease);
    await maintenance.backend.finalizeRestore(
      lease.token,
      seeds.map((seed) => seed.document),
      expectedInserted,
    );
    maintenance.complete(lease);
    finalized = true;
    return report;
  } finally {
    if (!finalized) {
      try {
        await maintenance.backend.clearStaging(lease.token);
      } finally {
        await maintenance.release(lease);
      }
    }
  }
}

async function resetAll(
  lifecycle: SnapshotLifecycle,
  maintenance: MaintenanceController,
): Promise<void> {
  const lease = await maintenance.acquire("reset");
  let finalized = false;
  try {
    const seeds = await lifecycle.prepareSeeds();
    await maintenance.renew(lease);
    await maintenance.backend.reset(
      lease.token,
      seeds.map((seed) => seed.document),
    );
    maintenance.complete(lease);
    finalized = true;
  } finally {
    if (!finalized) await maintenance.release(lease);
  }
}

async function validateAndStageDocument(
  lifecycle: SnapshotLifecycle,
  maintenance: MaintenanceController,
  lease: LeaseHandle,
  document: SnapshotStoredDocument,
): Promise<void> {
  const uniqueConstraints = await lifecycle.validateRestoredDocument(document);
  await stageUniqueConstraints(maintenance, lease, uniqueConstraints);
  try {
    await maintenance.backend.stageDocument(lease.token, document);
  } catch (error) {
    if (error instanceof SnapshotInvalidDocumentError) throw error;
    throw new SnapshotInvalidDocumentError("Snapshot contains duplicate document metadata");
  }
}

async function stageUniqueConstraints(
  maintenance: MaintenanceController,
  lease: LeaseHandle,
  uniqueConstraints: readonly SnapshotUniqueConstraint[],
): Promise<void> {
  for (const constraint of uniqueConstraints) {
    await maintenance.backend.stageUnique(
      lease.token,
      constraint.collection,
      constraint.name,
      constraint.valueKey,
      constraint.documentId,
    );
  }
}

function collectionCatalog(lifecycle: SnapshotLifecycle) {
  return [...lifecycle.listCollections()].sort((left, right) => compareUtf8(left.name, right.name));
}

function collectionManifest(
  lifecycle: SnapshotLifecycle,
): Array<{ name: string; schemaVersion: number }> {
  return collectionCatalog(lifecycle).map(({ name, currentSchemaVersion }) => ({
    name,
    schemaVersion: currentSchemaVersion,
  }));
}

function validateHeader(
  value: unknown,
  catalog: ReturnType<typeof collectionCatalog>,
): HeaderRecord {
  assertExactRecord(value, ["type", "format", "version", "collections"]);
  if (
    value.type !== "header" ||
    value.format !== SNAPSHOT_FORMAT ||
    value.version !== SNAPSHOT_VERSION ||
    !Array.isArray(value.collections)
  ) {
    throw new SnapshotIncompatibleError("Unsupported snapshot header");
  }
  const known = new Map(catalog.map((entry) => [entry.name, entry]));
  let previous: string | undefined;
  const manifest: HeaderRecord["collections"] = [];
  for (const entry of value.collections) {
    assertExactRecord(entry, ["name", "schemaVersion"]);
    if (
      typeof entry.name !== "string" ||
      typeof entry.schemaVersion !== "number" ||
      !Number.isInteger(entry.schemaVersion) ||
      entry.schemaVersion < 0
    ) {
      throw new SnapshotFormatError("Invalid collection manifest entry");
    }
    if (previous !== undefined && compareUtf8(previous, entry.name) >= 0) {
      throw new SnapshotFormatError("Collection manifest is not strictly ordered");
    }
    const definition = known.get(entry.name);
    if (definition === undefined) {
      throw new SnapshotIncompatibleError(`Unknown snapshot collection: ${entry.name}`);
    }
    if (
      entry.schemaVersion < definition.baseSchemaVersion ||
      entry.schemaVersion > definition.currentSchemaVersion
    ) {
      throw new SnapshotIncompatibleError(`Unsupported snapshot collection version: ${entry.name}`);
    }
    previous = entry.name;
    manifest.push({ name: entry.name, schemaVersion: entry.schemaVersion });
  }
  return {
    type: "header",
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    collections: manifest,
  };
}

function validateDocumentRecord(
  value: unknown,
  header: HeaderRecord,
  catalog: ReturnType<typeof collectionCatalog>,
  previous: { collection: string; id: string } | undefined,
): SnapshotStoredDocument {
  assertExactRecord(value, [
    "type",
    "collection",
    "id",
    "createdAt",
    "updatedAt",
    "schemaVersion",
    "revision",
    "data",
  ]);
  if (
    value.type !== "document" ||
    typeof value.collection !== "string" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Number.isInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 0 ||
    typeof value.revision !== "number" ||
    !Number.isFinite(value.revision) ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    !isPlainRecord(value.data)
  ) {
    throw new SnapshotInvalidDocumentError("Invalid snapshot document metadata");
  }
  assertCanonicalTimestamp(value.createdAt, "createdAt");
  assertCanonicalTimestamp(value.updatedAt, "updatedAt");
  for (const key of RESERVED_DOCUMENT_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value.data, key)) {
      throw new SnapshotInvalidDocumentError(`Snapshot document data contains reserved key ${key}`);
    }
  }
  const manifest = header.collections.find(({ name }) => name === value.collection);
  const known = catalog.some(({ name }) => name === value.collection);
  if (manifest === undefined || !known) {
    throw new SnapshotIncompatibleError(`Unknown snapshot collection: ${value.collection}`);
  }
  if ((value.schemaVersion as number) > manifest.schemaVersion) {
    throw new SnapshotIncompatibleError(
      `Document version exceeds snapshot manifest: ${value.collection}`,
    );
  }
  if (
    previous !== undefined &&
    (compareUtf8(previous.collection, value.collection) > 0 ||
      (previous.collection === value.collection && compareUtf8(previous.id, value.id) >= 0))
  ) {
    throw new SnapshotFormatError("Snapshot documents are not strictly ordered");
  }
  return {
    collection: value.collection,
    id: value.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    schemaVersion: value.schemaVersion as number,
    revision: value.revision,
    data: value.data,
  };
}

function validateTrailer(
  value: Record<string, unknown>,
  header: HeaderRecord,
  counts: Record<string, number>,
  checksum: string,
): void {
  assertExactRecord(value, ["type", "counts", "sha256"]);
  if (
    value.type !== "trailer" ||
    !isPlainRecord(value.counts) ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new SnapshotFormatError("Invalid snapshot trailer");
  }
  const trailerCounts = value.counts;
  const names = header.collections.map(({ name }) => name);
  const countNames = Object.keys(trailerCounts);
  if (
    countNames.length !== names.length ||
    countNames.some((name, index) => name !== names[index]) ||
    names.some(
      (name) =>
        !Number.isInteger(trailerCounts[name]) ||
        (trailerCounts[name] as number) < 0 ||
        trailerCounts[name] !== counts[name],
    )
  ) {
    throw new SnapshotFormatError("Snapshot document counts do not match");
  }
  if (value.sha256 !== checksum) throw new SnapshotFormatError("Snapshot checksum does not match");
}

function encodeRecord(record: HeaderRecord | DocumentRecord | TrailerRecord): Uint8Array {
  const bytes = encoder.encode(`${JSON.stringify(record)}\n`);
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new SnapshotInvalidDocumentError("Snapshot record exceeds the maximum size");
  }
  return bytes;
}

async function* readSnapshotLines(
  source: ReadableStream<Uint8Array>,
  onChunk: () => Promise<void>,
): AsyncGenerator<{ content: Uint8Array; encoded: Uint8Array }> {
  const reader = source.getReader();
  let pending: Uint8Array[] = [];
  let pendingLength = 0;
  let reachedEnd = false;
  let canceled = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      if (!(value instanceof Uint8Array))
        throw new SnapshotFormatError("Snapshot chunk is invalid");
      await onChunk();
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== 0x0a) continue;
        const segment = value.subarray(start, index);
        const length = pendingLength + segment.length;
        if (length === 0) throw new SnapshotFormatError("Snapshot contains an empty record");
        if (length + 1 > MAX_RECORD_BYTES) {
          throw new SnapshotFormatError("Snapshot record exceeds the maximum size");
        }
        const content = new Uint8Array(length);
        let offset = 0;
        for (const part of pending) {
          content.set(part, offset);
          offset += part.length;
        }
        content.set(segment, offset);
        if (content.at(-1) === 0x0d) {
          throw new SnapshotFormatError("Snapshot must use LF line endings");
        }
        const encoded = new Uint8Array(length + 1);
        encoded.set(content);
        encoded[length] = 0x0a;
        yield { content, encoded };
        pending = [];
        pendingLength = 0;
        start = index + 1;
      }
      if (start < value.length) {
        const remainder = value.slice(start);
        pendingLength += remainder.length;
        if (pendingLength + 1 > MAX_RECORD_BYTES) {
          throw new SnapshotFormatError("Snapshot record exceeds the maximum size");
        }
        pending.push(remainder);
      }
    }
    if (pendingLength !== 0) {
      throw new SnapshotFormatError("Snapshot final record is not newline terminated");
    }
  } catch (error) {
    canceled = true;
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (!reachedEnd && !canceled) {
      await reader
        .cancel(new SnapshotFormatError("Snapshot restore stopped before end of stream"))
        .catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function parseRecord(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new SnapshotFormatError("Snapshot contains invalid UTF-8 or JSON");
  }
}

function assertCanonicalTimestamp(value: string, field: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new SnapshotInvalidDocumentError(`Snapshot ${field} is not a canonical timestamp`);
  }
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new SnapshotFormatError("Snapshot record must be an object");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new SnapshotFormatError("Snapshot record has unexpected properties");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRecordWithType(
  value: unknown,
  type: string,
): value is Record<string, unknown> & { type: string } {
  return isPlainRecord(value) && value.type === type;
}
