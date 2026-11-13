import {
  MaintenanceLockedError,
  SnapshotInvalidDocumentError,
  type CollectionsDef,
  type TrustedCollectionsApi,
} from "@takibi/api";
import {
  isSqlCommitOutcomeUnknown,
  type SqlExecutor,
  type SqlStatementExecutor,
} from "@takibi/storage";
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

type LeaseRow = {
  owner_token: string;
  expires_at: number;
};

type SnapshotDocumentRow = {
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

async function initializeMaintenanceLayout(sql: SqlExecutor): Promise<void> {
  await sql.exec(
    `CREATE TABLE IF NOT EXISTS takibi_maintenance_lease (
      lease_key TEXT PRIMARY KEY CHECK (lease_key = 'global'),
      owner_token TEXT NOT NULL CHECK (owner_token <> ''),
      purpose TEXT NOT NULL CHECK (purpose IN ('export', 'restore', 'reset')),
      acquired_at REAL NOT NULL,
      expires_at REAL NOT NULL
    ) WITHOUT ROWID`,
  );
  await sql.exec(
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
  await sql.exec(
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

  constructor(
    backend: MaintenanceBackend,
    private readonly onChange?: (purpose: MaintenancePurpose | undefined) => void,
  ) {
    this.backend = backend;
  }

  get blocked(): boolean {
    return this.#pending || this.#hasLiveLease();
  }

  #notify(purpose?: MaintenancePurpose): void {
    try {
      this.onChange?.(purpose);
    } catch {
      /* Observers cannot affect maintenance. */
    }
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
    this.#notify(purpose);
    try {
      await this.#waitForIdle();
      const token = crypto.randomUUID();
      let lease: { expiresAt: number } | undefined;
      try {
        lease = await this.backend.acquire(token, purpose, LEASE_TTL_SECONDS);
      } catch (error) {
        // The lease may be held in the database although acquire failed.
        // Drop it by this owner token (idempotent, so not a replay), so it
        // does not refuse the next acquire until it expires. If that fails
        // too, the lease still expires on its own.
        if (isSqlCommitOutcomeUnknown(error)) {
          await this.backend.release(token).catch(() => undefined);
        }
        throw error;
      }
      if (lease === undefined) throw new MaintenanceLockedError();
      this.#current = { token, purpose, expiresAt: lease.expiresAt };
      return this.#current;
    } finally {
      this.#pending = false;
      if (!this.#current) this.#notify();
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
    try {
      await this.backend.release(lease.token);
    } catch (error) {
      // Whether or not the release committed, the work that held the lease
      // is over: stop excluding normal operations rather than until expiry.
      // A lease row left behind only refuses the next acquire until it
      // expires. Renew needs no such care: on an unknown outcome the handle
      // keeps its older, earlier expiry.
      if (isSqlCommitOutcomeUnknown(error)) this.complete(lease);
      throw error;
    }
    this.complete(lease);
  }

  complete(lease: LeaseHandle): void {
    if (this.#current?.token === lease.token) this.#current = undefined;
    // A normal operation may already have noticed expiry and cleared #current.
    if (!this.blocked) this.#notify();
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

export class SqliteMaintenanceBackend implements MaintenanceBackend {
  readonly #sql: SqlExecutor;

  private constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  /**
   * Create the maintenance lease and restore staging tables on `sql` if they
   * are missing, then return the backend over them. This is the only way to
   * obtain a backend, so every backend runs on an initialised layout.
   */
  static async open(sql: SqlExecutor): Promise<SqliteMaintenanceBackend> {
    await initializeMaintenanceLayout(sql);
    return new SqliteMaintenanceBackend(sql);
  }

  async cleanupAbandoned(): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await tx.exec("DELETE FROM takibi_restore_staging_unique");
      await tx.exec("DELETE FROM takibi_restore_staging_documents");
      await tx.exec("DELETE FROM takibi_maintenance_lease");
    });
  }

  async acquire(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<{ expiresAt: number } | undefined> {
    return this.#sql.transaction(async (tx) => {
      const row = (
        await tx.exec<LeaseRow>(
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
      ).rows[0];
      return row?.owner_token === ownerToken ? { expiresAt: row.expires_at * 1_000 } : undefined;
    });
  }

  async renew(
    ownerToken: string,
    purpose: MaintenancePurpose,
    ttlSeconds: number,
  ): Promise<number | undefined> {
    return this.#sql.transaction(async (tx) => {
      const row = (
        await tx.exec<LeaseRow>(
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
      ).rows[0];
      return row?.owner_token === ownerToken ? row.expires_at * 1_000 : undefined;
    });
  }

  async release(ownerToken: string): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await tx.exec(
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
    const { rows } =
      cursor === undefined
        ? await this.#sql.read<SnapshotDocumentRow>(
            `SELECT collection, id, created_at, updated_at, schema_version, revision, data
               FROM takibi_documents
               ORDER BY collection ASC, id ASC
               LIMIT ?`,
            limit,
          )
        : await this.#sql.read<SnapshotDocumentRow>(
            `SELECT collection, id, created_at, updated_at, schema_version, revision, data
               FROM takibi_documents
               WHERE collection > ? OR (collection = ? AND id > ?)
               ORDER BY collection ASC, id ASC
               LIMIT ?`,
            cursor.collection,
            cursor.collection,
            cursor.id,
            limit,
          );
    return rows.map(decodeSnapshotRow);
  }

  async clearStaging(ownerToken: string): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await tx.exec("DELETE FROM takibi_restore_staging_unique WHERE owner_token = ?", ownerToken);
      await tx.exec(
        "DELETE FROM takibi_restore_staging_documents WHERE owner_token = ?",
        ownerToken,
      );
    });
  }

  async stageDocument(ownerToken: string, document: SnapshotStoredDocument): Promise<void> {
    await this.#sql.exec(
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
      await this.#sql.exec(
        `INSERT INTO takibi_restore_staging_unique
           (owner_token, collection, constraint_name, value_key, document_id)
         VALUES (?, ?, ?, ?, ?)`,
        ownerToken,
        collection,
        constraint,
        valueKey,
        documentId,
      );
    } catch (error) {
      // Only a rejected insert is a duplicate; an unknown commit outcome is not.
      if (isSqlCommitOutcomeUnknown(error)) throw error;
      throw new SnapshotInvalidDocumentError(
        `Unique constraint violated: ${collection}.${constraint}`,
      );
    }
  }

  async hasStagedDocument(ownerToken: string, collection: string, id: string): Promise<boolean> {
    return (
      (
        await this.#sql.read<{ found: number }>(
          `SELECT 1 AS found
           FROM takibi_restore_staging_documents
           WHERE owner_token = ? AND collection = ? AND id = ?`,
          ownerToken,
          collection,
          id,
        )
      ).rows[0] !== undefined
    );
  }

  async finalizeRestore(
    ownerToken: string,
    seeds: readonly SnapshotStoredDocument[],
    expectedSeedsInserted: number,
  ): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await assertOwner(tx, ownerToken, "restore");
      await tx.exec("DELETE FROM takibi_documents");
      await tx.exec(
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
        inserted += await insertSeed(tx, seed);
      }
      if (inserted !== expectedSeedsInserted) {
        throw new SnapshotInvalidDocumentError("Seed reconciliation count mismatch");
      }
      await tx.exec("DELETE FROM takibi_restore_staging_unique WHERE owner_token = ?", ownerToken);
      await tx.exec(
        "DELETE FROM takibi_restore_staging_documents WHERE owner_token = ?",
        ownerToken,
      );
      await deleteLease(tx, ownerToken);
    });
  }

  async reset(ownerToken: string, seeds: readonly SnapshotStoredDocument[]): Promise<void> {
    await this.#sql.transaction(async (tx) => {
      await assertOwner(tx, ownerToken, "reset");
      await tx.exec("DELETE FROM takibi_documents");
      for (const seed of seeds) await insertSeed(tx, seed);
      await deleteLease(tx, ownerToken);
    });
  }
}

async function insertSeed(
  sql: SqlStatementExecutor,
  seed: SnapshotStoredDocument,
): Promise<number> {
  // Count inserted rows with RETURNING: a host's write counter may include
  // index entries (Durable Object SQLite does), which would not equal 0 or 1.
  const { rows } = await sql.exec<{ id: string }>(
    `INSERT OR IGNORE INTO takibi_documents
       (collection, id, created_at, updated_at, schema_version, revision, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    seed.collection,
    seed.id,
    seed.createdAt,
    seed.updatedAt,
    seed.schemaVersion,
    seed.revision,
    JSON.stringify(seed.data),
  );
  return rows.length;
}

async function assertOwner(
  sql: SqlStatementExecutor,
  ownerToken: string,
  purpose: MaintenancePurpose,
): Promise<void> {
  const row = (
    await sql.exec<LeaseRow>(
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
  ).rows[0];
  if (row?.owner_token !== ownerToken) {
    throw new MaintenanceLockedError("Maintenance lease expired or ownership was lost");
  }
}

async function deleteLease(sql: SqlStatementExecutor, ownerToken: string): Promise<void> {
  await sql.exec(
    "DELETE FROM takibi_maintenance_lease WHERE lease_key = ? AND owner_token = ?",
    LEASE_KEY,
    ownerToken,
  );
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
