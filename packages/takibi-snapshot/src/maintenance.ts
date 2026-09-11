import {
  MaintenanceLockedError,
  SnapshotInvalidDocumentError,
  type CollectionsDef,
  type TrustedCollectionsApi,
} from "@takibi/takibi-api";
import type {
  LeaseHandle,
  MaintenancePurpose,
  SnapshotScanCursor,
  SnapshotStoredDocument,
} from "./types";

export type {
  LeaseHandle,
  MaintenancePurpose,
  SnapshotScanCursor,
  SnapshotStoredDocument,
} from "./types";

type LeaseRow = Record<string, SqlStorageValue> & {
  owner_token: string;
  expires_at: number;
};

type SnapshotDocumentRow = Record<string, SqlStorageValue> & {
  collection: string;
  id: string;
  created_at: string;
  updated_at: string;
  schema_version: number;
  revision: number;
  data: string;
};

const LEASE_KEY = "global";
const LEASE_TTL_SECONDS = 30;
const DRAIN_TIMEOUT_MS = 5_000;

export function initializeMaintenanceLayout(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS takibi_maintenance_lease (
      lease_key TEXT PRIMARY KEY CHECK (lease_key = 'global'),
      owner_token TEXT NOT NULL CHECK (owner_token <> ''),
      purpose TEXT NOT NULL CHECK (purpose IN ('export', 'restore', 'reset')),
      acquired_at REAL NOT NULL,
      expires_at REAL NOT NULL
    ) WITHOUT ROWID`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS takibi_restore_staging_documents (
      owner_token TEXT NOT NULL,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      revision REAL NOT NULL CHECK (
        revision >= 1
        AND (
          revision >= 9007199254740992
          OR revision = CAST(revision AS INTEGER)
        )
      ),
      data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
      PRIMARY KEY (owner_token, collection, id)
    ) WITHOUT ROWID`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS takibi_restore_staging_unique (
      owner_token TEXT NOT NULL,
      collection TEXT NOT NULL,
      constraint_name TEXT NOT NULL,
      value_key TEXT NOT NULL,
      document_id TEXT NOT NULL,
      PRIMARY KEY (owner_token, collection, constraint_name, value_key)
    ) WITHOUT ROWID`,
  );
}

export interface MaintenanceBackend {
  cleanupAbandoned(): Promise<void>;
  acquire(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<{ expiresAt: number } | undefined>;
  renew(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<number | undefined>;
  release(ownerToken: string): Promise<void>;
  scanDocuments(
    cursor: SnapshotScanCursor | undefined,
    limit: number,
  ): Promise<SnapshotStoredDocument[]>;
  clearStaging(ownerToken: string): Promise<void>;
  stageDocument(ownerToken: string, document: SnapshotStoredDocument): Promise<void>;
  stageUnique(
    ownerToken: string,
    collection: string,
    constraint: string,
    valueKey: string,
    documentId: string,
  ): Promise<void>;
  hasStagedDocument(ownerToken: string, collection: string, id: string): Promise<boolean>;
  finalizeRestore(
    ownerToken: string,
    seeds: readonly SnapshotStoredDocument[],
    expectedSeedsInserted: number,
  ): Promise<void>;
  reset(ownerToken: string, seeds: readonly SnapshotStoredDocument[]): Promise<void>;
}

export class MaintenanceController {
  readonly backend: MaintenanceBackend;
  #activeOperations = 0;
  #pending = false;
  #current: LeaseHandle | undefined;
  #idleResolvers = new Set<() => void>();

  constructor(storage: DurableObjectStorage | MaintenanceBackend) {
    this.backend = "sql" in storage ? new SqliteMaintenanceBackend(storage) : storage;
  }

  async cleanupAbandoned(): Promise<void> {
    await this.backend.cleanupAbandoned();
    this.#current = undefined;
    this.#pending = false;
  }

  async runNormal<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#pending || this.#hasLiveLease()) throw new MaintenanceLockedError();
    this.#activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolve of this.#idleResolvers) resolve();
        this.#idleResolvers.clear();
      }
    }
  }

  async acquire(purpose: MaintenancePurpose): Promise<LeaseHandle> {
    if (this.#pending || this.#hasLiveLease()) throw new MaintenanceLockedError();
    this.#pending = true;
    try {
      await this.#waitForIdle();
      const token = crypto.randomUUID();
      const lease = await this.backend.acquire(token, purpose, LEASE_TTL_SECONDS);
      if (lease === undefined) throw new MaintenanceLockedError();
      this.#current = { token, purpose, expiresAt: lease.expiresAt };
      return this.#current;
    } finally {
      this.#pending = false;
    }
  }

  async renew(lease: LeaseHandle): Promise<void> {
    if (this.#current?.token !== lease.token || Date.now() >= lease.expiresAt) {
      throw new MaintenanceLockedError("Maintenance lease expired or ownership was lost");
    }
    const expiresAt = await this.backend.renew(lease.token, lease.purpose, LEASE_TTL_SECONDS);
    if (expiresAt === undefined) {
      this.#current = undefined;
      throw new MaintenanceLockedError("Maintenance lease expired or ownership was lost");
    }
    lease.expiresAt = expiresAt;
  }

  async release(lease: LeaseHandle): Promise<void> {
    await this.backend.release(lease.token);
    if (this.#current?.token === lease.token) this.#current = undefined;
  }

  complete(lease: LeaseHandle): void {
    if (this.#current?.token === lease.token) this.#current = undefined;
  }

  #hasLiveLease(): boolean {
    if (this.#current === undefined) return false;
    if (Date.now() < this.#current.expiresAt) return true;
    this.#current = undefined;
    return false;
  }

  async #waitForIdle(): Promise<void> {
    if (this.#activeOperations === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => this.#idleResolvers.add(resolve)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new MaintenanceLockedError("Timed out draining active operations")),
            DRAIN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export function createMaintenanceGatedCollections<TCollections extends CollectionsDef>(
  collections: TrustedCollectionsApi<TCollections>,
  controller: MaintenanceController,
): TrustedCollectionsApi<TCollections> {
  const collectionProxies = new Map<PropertyKey, object>();
  return new Proxy(collections, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "$transaction" && typeof value === "function") {
        return (...args: unknown[]) =>
          controller.runNormal(() => Reflect.apply(value, target, args));
      }
      if (typeof value !== "object" || value === null) return value;
      const cached = collectionProxies.get(property);
      if (cached !== undefined) return cached;
      const proxy = new Proxy(value, {
        get(collection, method, collectionReceiver) {
          const member = Reflect.get(collection, method, collectionReceiver) as unknown;
          if (typeof member !== "function") return member;
          return (...args: unknown[]) =>
            controller.runNormal(() => Reflect.apply(member, collection, args));
        },
      });
      collectionProxies.set(property, proxy);
      return proxy;
    },
  });
}

export class SqliteMaintenanceBackend {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    initializeMaintenanceLayout(storage.sql);
    this.#storage = storage;
  }

  async cleanupAbandoned(): Promise<void> {
    await this.#storage.transaction(async () => {
      this.#storage.sql.exec("DELETE FROM takibi_restore_staging_unique");
      this.#storage.sql.exec("DELETE FROM takibi_restore_staging_documents");
      this.#storage.sql.exec("DELETE FROM takibi_maintenance_lease");
    });
  }

  async acquire(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<{ expiresAt: number } | undefined> {
    return this.#storage.transaction(async () => {
      const row = this.#storage.sql
        .exec<LeaseRow>(
          `INSERT INTO takibi_maintenance_lease
             (lease_key, owner_token, purpose, acquired_at, expires_at)
           VALUES (?, ?, ?, unixepoch('now', 'subsec'), unixepoch('now', 'subsec') + ?)
           ON CONFLICT (lease_key) DO UPDATE SET
             owner_token = excluded.owner_token,
             purpose = excluded.purpose,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at
           WHERE takibi_maintenance_lease.expires_at <= unixepoch('now', 'subsec')
           RETURNING owner_token, expires_at`,
          LEASE_KEY,
          ownerToken,
          purpose,
          ttlSeconds,
        )
        .toArray()[0];
      return row?.owner_token === ownerToken ? { expiresAt: row.expires_at * 1_000 } : undefined;
    });
  }

  async renew(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<number | undefined> {
    return this.#storage.transaction(async () => {
      const row = this.#storage.sql
        .exec<LeaseRow>(
          `UPDATE takibi_maintenance_lease
           SET expires_at = unixepoch('now', 'subsec') + ?
           WHERE lease_key = ?
             AND owner_token = ?
             AND purpose = ?
             AND expires_at > unixepoch('now', 'subsec')
           RETURNING owner_token, expires_at`,
          ttlSeconds,
          LEASE_KEY,
          ownerToken,
          purpose,
        )
        .toArray()[0];
      return row?.owner_token === ownerToken ? row.expires_at * 1_000 : undefined;
    });
  }

  async release(ownerToken: string): Promise<void> {
    await this.#storage.transaction(async () => {
      this.#storage.sql.exec(
        "DELETE FROM takibi_maintenance_lease WHERE lease_key = ? AND owner_token = ?",
        LEASE_KEY,
        ownerToken,
      );
    });
  }

  async scanDocuments(
    cursor: SnapshotScanCursor | undefined,
    limit: number,
  ): Promise<SnapshotStoredDocument[]> {
    const rows =
      cursor === undefined
        ? this.#storage.sql
            .exec<SnapshotDocumentRow>(
              `SELECT collection, id, created_at, updated_at, schema_version, revision, data
               FROM takibi_documents
               ORDER BY collection ASC, id ASC
               LIMIT ?`,
              limit,
            )
            .toArray()
        : this.#storage.sql
            .exec<SnapshotDocumentRow>(
              `SELECT collection, id, created_at, updated_at, schema_version, revision, data
               FROM takibi_documents
               WHERE collection > ? OR (collection = ? AND id > ?)
               ORDER BY collection ASC, id ASC
               LIMIT ?`,
              cursor.collection,
              cursor.collection,
              cursor.id,
              limit,
            )
            .toArray();
    return rows.map(decodeSnapshotRow);
  }

  async clearStaging(ownerToken: string): Promise<void> {
    await this.#storage.transaction(async () => {
      this.#storage.sql.exec(
        "DELETE FROM takibi_restore_staging_unique WHERE owner_token = ?",
        ownerToken,
      );
      this.#storage.sql.exec(
        "DELETE FROM takibi_restore_staging_documents WHERE owner_token = ?",
        ownerToken,
      );
    });
  }

  async stageDocument(ownerToken: string, document: SnapshotStoredDocument): Promise<void> {
    this.#storage.sql.exec(
      `INSERT INTO takibi_restore_staging_documents
         (owner_token, collection, id, created_at, updated_at, schema_version, revision, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ownerToken,
      document.collection,
      document.id,
      document.createdAt,
      document.updatedAt,
      document.schemaVersion,
      document.revision,
      JSON.stringify(document.data),
    );
  }

  async stageUnique(
    ownerToken: string,
    collection: string,
    constraint: string,
    valueKey: string,
    documentId: string,
  ): Promise<void> {
    try {
      this.#storage.sql.exec(
        `INSERT INTO takibi_restore_staging_unique
           (owner_token, collection, constraint_name, value_key, document_id)
         VALUES (?, ?, ?, ?, ?)`,
        ownerToken,
        collection,
        constraint,
        valueKey,
        documentId,
      );
    } catch {
      throw new SnapshotInvalidDocumentError(
        `Unique constraint violated: ${collection}.${constraint}`,
      );
    }
  }

  async hasStagedDocument(ownerToken: string, collection: string, id: string): Promise<boolean> {
    return (
      this.#storage.sql
        .exec<{ found: number }>(
          `SELECT 1 AS found
           FROM takibi_restore_staging_documents
           WHERE owner_token = ? AND collection = ? AND id = ?`,
          ownerToken,
          collection,
          id,
        )
        .toArray()[0] !== undefined
    );
  }

  async finalizeRestore(
    ownerToken: string,
    seeds: readonly SnapshotStoredDocument[],
    expectedSeedsInserted: number,
  ): Promise<void> {
    await this.#storage.transaction(async () => {
      this.#assertOwner(ownerToken, "restore");
      this.#storage.sql.exec("DELETE FROM takibi_documents");
      this.#storage.sql.exec(
        `INSERT INTO takibi_documents
           (collection, id, created_at, updated_at, schema_version, revision, data)
         SELECT collection, id, created_at, updated_at, schema_version, revision, data
         FROM takibi_restore_staging_documents
         WHERE owner_token = ?
         ORDER BY collection, id`,
        ownerToken,
      );
      let inserted = 0;
      for (const seed of seeds) {
        inserted += this.#insertSeed(seed);
      }
      if (inserted !== expectedSeedsInserted) {
        throw new SnapshotInvalidDocumentError("Seed reconciliation count mismatch");
      }
      this.#storage.sql.exec(
        "DELETE FROM takibi_restore_staging_unique WHERE owner_token = ?",
        ownerToken,
      );
      this.#storage.sql.exec(
        "DELETE FROM takibi_restore_staging_documents WHERE owner_token = ?",
        ownerToken,
      );
      this.#deleteLease(ownerToken);
    });
  }

  async reset(ownerToken: string, seeds: readonly SnapshotStoredDocument[]): Promise<void> {
    await this.#storage.transaction(async () => {
      this.#assertOwner(ownerToken, "reset");
      this.#storage.sql.exec("DELETE FROM takibi_documents");
      for (const seed of seeds) this.#insertSeed(seed);
      this.#deleteLease(ownerToken);
    });
  }

  #insertSeed(seed: SnapshotStoredDocument): number {
    return this.#storage.sql.exec(
      `INSERT OR IGNORE INTO takibi_documents
         (collection, id, created_at, updated_at, schema_version, revision, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      seed.collection,
      seed.id,
      seed.createdAt,
      seed.updatedAt,
      seed.schemaVersion,
      seed.revision,
      JSON.stringify(seed.data),
    ).rowsWritten;
  }

  #assertOwner(ownerToken: string, purpose: MaintenancePurpose): void {
    const row = this.#storage.sql
      .exec<LeaseRow>(
        `SELECT owner_token, expires_at
         FROM takibi_maintenance_lease
         WHERE lease_key = ?
           AND owner_token = ?
           AND purpose = ?
           AND expires_at > unixepoch('now', 'subsec')`,
        LEASE_KEY,
        ownerToken,
        purpose,
      )
      .toArray()[0];
    if (row?.owner_token !== ownerToken) {
      throw new MaintenanceLockedError("Maintenance lease expired or ownership was lost");
    }
  }

  #deleteLease(ownerToken: string): void {
    this.#storage.sql.exec(
      "DELETE FROM takibi_maintenance_lease WHERE lease_key = ? AND owner_token = ?",
      LEASE_KEY,
      ownerToken,
    );
  }
}

function decodeSnapshotRow(row: SnapshotDocumentRow): SnapshotStoredDocument {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new SnapshotInvalidDocumentError("Stored document contains invalid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new SnapshotInvalidDocumentError("Stored document data must be an object");
  }
  return {
    collection: row.collection,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    schemaVersion: row.schema_version,
    revision: row.revision,
    data: data as Record<string, unknown>,
  };
}
