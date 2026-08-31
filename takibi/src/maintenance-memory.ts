import { MaintenanceLockedError, SnapshotInvalidDocumentError } from "./errors";
import type {
  MaintenanceBackend,
  MaintenancePurpose,
  SnapshotScanCursor,
  SnapshotStoredDocument,
} from "./maintenance";

type MemoryLease = {
  ownerToken: string;
  purpose: MaintenancePurpose;
  expiresAt: number;
};

const encoder = new TextEncoder();

export class MemoryMaintenanceBackend implements MaintenanceBackend {
  #lease: MemoryLease | undefined;
  #live = new Map<string, SnapshotStoredDocument>();
  #staging = new Map<string, Map<string, SnapshotStoredDocument>>();
  #stagingUnique = new Map<string, Set<string>>();

  async cleanupAbandoned(): Promise<void> {
    this.#lease = undefined;
    this.#staging.clear();
    this.#stagingUnique.clear();
  }

  async acquire(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<{ expiresAt: number } | undefined> {
    if (this.#lease !== undefined && this.#lease.expiresAt > Date.now()) return undefined;
    const expiresAt = Date.now() + ttlSeconds * 1_000;
    this.#lease = { ownerToken, purpose, expiresAt };
    return { expiresAt };
  }

  async renew(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<number | undefined> {
    if (
      this.#lease?.ownerToken !== ownerToken ||
      this.#lease.purpose !== purpose ||
      this.#lease.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    this.#lease.expiresAt = Date.now() + ttlSeconds * 1_000;
    return this.#lease.expiresAt;
  }

  async release(ownerToken: string): Promise<void> {
    if (this.#lease?.ownerToken === ownerToken) this.#lease = undefined;
  }

  async scanDocuments(
    cursor: SnapshotScanCursor | undefined,
    limit: number,
  ): Promise<SnapshotStoredDocument[]> {
    if (limit <= 0) return [];
    const page: SnapshotStoredDocument[] = [];
    for (const document of this.#live.values()) {
      if (cursor !== undefined && compareDocumentKey(document, cursor) <= 0) continue;
      const position = insertionIndex(page, document);
      if (position >= limit) continue;
      page.splice(position, 0, document);
      if (page.length > limit) page.pop();
    }
    return page.map(cloneDocument);
  }

  async clearStaging(ownerToken: string): Promise<void> {
    this.#staging.delete(ownerToken);
    this.#stagingUnique.delete(ownerToken);
  }

  async stageDocument(ownerToken: string, document: SnapshotStoredDocument): Promise<void> {
    const staging = this.#staging.get(ownerToken) ?? new Map<string, SnapshotStoredDocument>();
    const key = documentKey(document.collection, document.id);
    if (staging.has(key)) {
      throw new SnapshotInvalidDocumentError("Snapshot contains duplicate document metadata");
    }
    staging.set(key, cloneDocument(document));
    this.#staging.set(ownerToken, staging);
  }

  async stageUnique(
    ownerToken: string,
    collection: string,
    constraint: string,
    valueKey: string,
    _documentId: string,
  ): Promise<void> {
    const unique = this.#stagingUnique.get(ownerToken) ?? new Set<string>();
    const key = JSON.stringify([collection, constraint, valueKey]);
    if (unique.has(key)) {
      throw new SnapshotInvalidDocumentError(
        `Unique constraint violated: ${collection}.${constraint}`,
      );
    }
    unique.add(key);
    this.#stagingUnique.set(ownerToken, unique);
  }

  async hasStagedDocument(ownerToken: string, collection: string, id: string): Promise<boolean> {
    return this.#staging.get(ownerToken)?.has(documentKey(collection, id)) ?? false;
  }

  async finalizeRestore(
    ownerToken: string,
    seeds: readonly SnapshotStoredDocument[],
    expectedSeedsInserted: number,
  ): Promise<void> {
    this.#assertOwner(ownerToken, "restore");
    const replacement = new Map<string, SnapshotStoredDocument>();
    for (const document of this.#staging.get(ownerToken)?.values() ?? []) {
      replacement.set(documentKey(document.collection, document.id), cloneDocument(document));
    }
    let inserted = 0;
    for (const seed of seeds) {
      const key = documentKey(seed.collection, seed.id);
      if (replacement.has(key)) continue;
      replacement.set(key, cloneDocument(seed));
      inserted += 1;
    }
    if (inserted !== expectedSeedsInserted) {
      throw new SnapshotInvalidDocumentError("Seed reconciliation count mismatch");
    }
    this.#live = replacement;
    this.#staging.delete(ownerToken);
    this.#stagingUnique.delete(ownerToken);
    this.#lease = undefined;
  }

  async reset(ownerToken: string, seeds: readonly SnapshotStoredDocument[]): Promise<void> {
    this.#assertOwner(ownerToken, "reset");
    this.#live = new Map(
      seeds.map((seed) => [documentKey(seed.collection, seed.id), cloneDocument(seed)]),
    );
    this.#lease = undefined;
  }

  writeLive(document: SnapshotStoredDocument): void {
    this.#live.set(documentKey(document.collection, document.id), cloneDocument(document));
  }

  readLive(collection: string, id: string): SnapshotStoredDocument | undefined {
    const document = this.#live.get(documentKey(collection, id));
    return document === undefined ? undefined : cloneDocument(document);
  }

  #assertOwner(ownerToken: string, purpose: MaintenancePurpose): void {
    if (
      this.#lease?.ownerToken !== ownerToken ||
      this.#lease.purpose !== purpose ||
      this.#lease.expiresAt <= Date.now()
    ) {
      throw new MaintenanceLockedError("Maintenance lease expired or ownership was lost");
    }
  }
}

function documentKey(collection: string, id: string): string {
  return JSON.stringify([collection, id]);
}

function cloneDocument(document: SnapshotStoredDocument): SnapshotStoredDocument {
  return structuredClone(document);
}

function insertionIndex(
  documents: readonly SnapshotStoredDocument[],
  candidate: SnapshotStoredDocument,
): number {
  let low = 0;
  let high = documents.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareDocumentKey(documents[middle]!, candidate) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function compareDocumentKey(
  left: Pick<SnapshotStoredDocument, "collection" | "id">,
  right: Pick<SnapshotStoredDocument, "collection" | "id">,
): number {
  return compareUtf8(left.collection, right.collection) || compareUtf8(left.id, right.id);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
