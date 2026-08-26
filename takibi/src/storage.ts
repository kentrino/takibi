import { BadRequestError, TakibiError } from "./errors";
import { assertJsonObject } from "./json";
import { matchesQuery, normalizeQueryExpr } from "./query";
import { compileQueryToSql } from "./sql-query";
import type {
  QueryExpr,
  StorageDriver,
  StorageListPlan,
  StorageListOptions,
  StoredDocument,
  WithMetadata,
} from "./types";
import { withDocumentRevision } from "./revision";
import { TAKIBI_VERSION_KEY } from "./types";

type ListCursorV2 = {
  v: 2;
  collection: string;
  where: QueryExpr | null;
  id: string;
};

const LIST_CHUNK_SIZE = 128;
const STORAGE_LAYOUT_VERSION = 1;
const STORAGE_LAYOUT_KEY = "layout_version";

type ScanItem = {
  id: string;
  document: StoredDocument;
};

type ReadChunk = (
  startAfter: string | undefined,
  limit: number,
) => Promise<ScanItem[]> | ScanItem[];

type PreparedList = {
  collection: string;
  where: QueryExpr | undefined;
  startAfter: string | undefined;
  limit: number;
};

type LayoutRow = Record<string, SqlStorageValue> & {
  value: number;
};

type DocumentRow = Record<string, SqlStorageValue> & {
  id: string;
  created_at: string;
  updated_at: string;
  schema_version: number;
  data: string;
};

export function createMemoryStorage(): StorageDriver {
  const state: MemoryState = { tables: new Map() };
  let writeQueue = Promise.resolve();
  const coordinate: WriteCoordinator = (operation) => {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return createMemoryDriver(state, coordinate);
}

type MemoryState = {
  tables: Map<string, Map<string, StoredDocument>>;
};

type WriteCoordinator = <T>(operation: () => T | Promise<T>) => Promise<T>;

function createMemoryDriver(state: MemoryState, coordinate: WriteCoordinator): StorageDriver {
  const immediate: WriteCoordinator = async (operation) => operation();

  const table = (resource: string) => {
    let t = state.tables.get(resource);
    if (!t) {
      t = new Map();
      state.tables.set(resource, t);
    }
    return t;
  };

  return {
    async get(resource, id) {
      const document = table(resource).get(id);
      return document === undefined ? null : withDocumentRevision(document);
    },
    async put(resource, doc) {
      await coordinate(() => {
        table(resource).set(doc.id, structuredClone(doc));
      });
    },
    async delete(resource, id) {
      return coordinate(() => table(resource).delete(id));
    },
    async list(resource, opts, plan) {
      const prepared = prepareList(resource, opts);
      const items = [...table(resource).values()]
        .sort((a, b) => compareIds(a.id, b.id))
        .map((document) => ({ id: document.id, document: withDocumentRevision(document) }));
      return paginate(
        prepared,
        async (startAfter, limit) => {
          const start =
            startAfter === undefined ? 0 : items.findIndex((item) => item.id > startAfter);
          return start < 0 ? [] : items.slice(start, start + limit);
        },
        plan,
      );
    },
    transaction(callback) {
      return coordinate(async () => {
        const scopedState: MemoryState = { tables: cloneMemoryTables(state.tables) };
        const result = await callback(createMemoryDriver(scopedState, immediate));
        state.tables = scopedState.tables;
        return result;
      });
    },
  };
}

function cloneMemoryTables(
  tables: Map<string, Map<string, StoredDocument>>,
): Map<string, Map<string, StoredDocument>> {
  return new Map(
    [...tables].map(([resource, documents]) => [
      resource,
      new Map([...documents].map(([id, document]) => [id, structuredClone(document)])),
    ]),
  );
}

export function createDurableObjectStorage(storage: DurableObjectStorage): StorageDriver {
  initializeStorageLayout(storage);

  const driver: StorageDriver = {
    async get(resource, id) {
      const rows = storage.sql
        .exec<DocumentRow>(
          `SELECT id, created_at, updated_at, schema_version, data
           FROM takibi_documents
           WHERE collection = ? AND id = ?`,
          resource,
          id,
        )
        .toArray();
      return rows[0] === undefined ? null : withDocumentRevision(rowToDocument(rows[0]));
    },
    async put(resource, doc) {
      const encoded = encodeDocument(doc);
      storage.sql.exec(
        `INSERT INTO takibi_documents
           (collection, id, created_at, updated_at, schema_version, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection, id) DO UPDATE SET
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           schema_version = excluded.schema_version,
           data = excluded.data`,
        resource,
        doc.id,
        doc.createdAt,
        doc.updatedAt,
        encoded.schemaVersion,
        encoded.data,
      );
    },
    async delete(resource, id) {
      return (
        storage.sql
          .exec<{ id: string }>(
            `DELETE FROM takibi_documents
             WHERE collection = ? AND id = ?
             RETURNING id`,
            resource,
            id,
          )
          .toArray().length > 0
      );
    },
    async list(resource, opts, plan) {
      const prepared = prepareList(resource, opts);
      return paginate(prepared, createSqlChunkReader(storage.sql, resource, prepared, plan), plan);
    },
    transaction(callback) {
      return storage.transaction(() => callback(driver));
    },
  };
  return driver;
}

function initializeStorageLayout(storage: DurableObjectStorage): void {
  if (typeof storage.transactionSync !== "function" || storage.sql === undefined) {
    throw new TakibiError("STORAGE_BACKEND", "Takibi requires a SQLite-backed Durable Object", 500);
  }

  storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS takibi_metadata (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );

    const row = storage.sql
      .exec<LayoutRow>("SELECT value FROM takibi_metadata WHERE key = ?", STORAGE_LAYOUT_KEY)
      .toArray()[0];
    let version = row?.value ?? 0;
    if (!Number.isInteger(version) || version < 0 || version > STORAGE_LAYOUT_VERSION) {
      throw new TakibiError(
        "STORAGE_LAYOUT_VERSION",
        `Unsupported Takibi storage layout version: ${String(version)}`,
        500,
      );
    }

    while (version < STORAGE_LAYOUT_VERSION) {
      if (version !== 0) {
        throw new TakibiError(
          "STORAGE_LAYOUT_VERSION",
          `No migration from Takibi storage layout version ${version}`,
          500,
        );
      }
      storage.sql.exec(
        `CREATE TABLE takibi_documents (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
          PRIMARY KEY (collection, id)
        ) WITHOUT ROWID`,
      );
      version = 1;
      storage.sql.exec(
        `INSERT INTO takibi_metadata (key, value)
         VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        STORAGE_LAYOUT_KEY,
        version,
      );
    }
  });
}

function createSqlChunkReader(
  sql: SqlStorage,
  resource: string,
  prepared: PreparedList,
  plan: StorageListPlan | undefined,
): ReadChunk {
  const predicate = prepared.where === undefined ? undefined : compileQueryToSql(prepared.where);

  return (startAfter, limit) => {
    const clauses = ["collection = ?"];
    const bindings: Array<string | number | null> = [resource];
    if (startAfter !== undefined) {
      clauses.push("id > ?");
      bindings.push(startAfter);
    }
    if (predicate !== undefined) {
      if (plan === undefined) {
        clauses.push(predicate.sql);
      } else {
        clauses.push(`(schema_version <> ? OR (schema_version = ? AND ${predicate.sql}))`);
        bindings.push(plan.currentVersion, plan.currentVersion);
      }
      bindings.push(...predicate.bindings);
    }
    bindings.push(limit);

    return sql
      .exec<DocumentRow>(
        `SELECT id, created_at, updated_at, schema_version, data
         FROM takibi_documents
         WHERE ${clauses.join(" AND ")}
         ORDER BY id ASC
         LIMIT ?`,
        ...bindings,
      )
      .toArray()
      .map((row) => ({ id: row.id, document: withDocumentRevision(rowToDocument(row)) }));
  };
}

function encodeDocument(document: StoredDocument): { schemaVersion: number; data: string } {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    [TAKIBI_VERSION_KEY]: rawVersion,
    ...data
  } = document;
  assertJsonObject(data, {
    subject: "Collection document",
    error: (message) => new TakibiError("INVALID_DOCUMENT", message, 500),
  });
  const schemaVersion = rawVersion ?? 0;
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 0) {
    throw new TakibiError(
      "MIGRATION_VERSION",
      "Stored document has an invalid migration version",
      500,
    );
  }
  return { schemaVersion: schemaVersion as number, data: JSON.stringify(data) };
}

function rowToDocument(row: DocumentRow): StoredDocument {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new TakibiError("INVALID_DOCUMENT", "Stored document contains invalid JSON", 500);
  }
  assertJsonObject(data, {
    subject: "Stored document",
    error: (message) => new TakibiError("INVALID_DOCUMENT", message, 500),
  });
  return withDocumentRevision({
    ...data,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.schema_version === 0 ? {} : { [TAKIBI_VERSION_KEY]: row.schema_version }),
  });
}

function prepareList(resource: string, opts: StorageListOptions | undefined): PreparedList {
  let where: QueryExpr | undefined;
  try {
    where = opts?.where === undefined ? undefined : normalizeQueryExpr(opts.where);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : "Invalid query");
  }

  const cursor = opts?.cursor === undefined ? undefined : decodeCursor(opts.cursor);
  if (cursor !== undefined && (cursor.collection !== resource || !sameQuery(cursor.where, where))) {
    throw new BadRequestError("Cursor does not match this collection and query");
  }

  if (
    opts?.limit !== undefined &&
    (typeof opts.limit !== "number" || !Number.isInteger(opts.limit) || opts.limit < 1)
  ) {
    throw new BadRequestError("Invalid list limit");
  }

  return {
    collection: resource,
    where,
    startAfter: cursor?.id,
    limit: Math.min(opts?.limit ?? 50, 200),
  };
}

async function paginate(
  prepared: PreparedList,
  readChunk: ReadChunk,
  plan: StorageListPlan | undefined,
): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }> {
  const page: WithMetadata<Record<string, unknown>>[] = [];
  let startAfter = prepared.startAfter;

  while (true) {
    const chunk = await readChunk(startAfter, LIST_CHUNK_SIZE);
    if (chunk.length === 0) break;

    for (const item of chunk) {
      startAfter = item.id;
      const document = plan ? await plan.transform(item.document) : item.document;
      if (prepared.where && !matchesQuery(document, prepared.where)) continue;
      if (page.length === prepared.limit) {
        const last = page.at(-1)!;
        return {
          items: page,
          nextCursor: encodeCursor(prepared.collection, prepared.where, last.id),
        };
      }
      page.push(document);
    }

    if (chunk.length < LIST_CHUNK_SIZE) break;
  }

  return { items: page };
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameQuery(cursorWhere: QueryExpr | null, where: QueryExpr | undefined): boolean {
  return JSON.stringify(cursorWhere) === JSON.stringify(where ?? null);
}

function encodeCursor(collection: string, where: QueryExpr | undefined, id: string): string {
  const cursor: ListCursorV2 = {
    v: 2,
    collection,
    where: where ?? null,
    id,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(token: string): ListCursorV2 {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length % 4 === 1) {
      throw new Error("Invalid base64url");
    }
    const base64 = token.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const value = JSON.parse(json) as unknown;
    if (!isRecord(value)) throw new Error("Invalid cursor object");
    assertExactCursorKeys(value);
    if (
      value.v !== 2 ||
      typeof value.collection !== "string" ||
      value.collection.length === 0 ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) {
      throw new Error("Invalid cursor fields");
    }
    const where = value.where === null ? null : normalizeQueryExpr(value.where);
    return { v: 2, collection: value.collection, where, id: value.id };
  } catch {
    throw new BadRequestError("Invalid list cursor");
  }
}

function assertExactCursorKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  const expected = ["v", "collection", "where", "id"];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("Invalid cursor fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
