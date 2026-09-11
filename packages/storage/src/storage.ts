import { normalizeQueryExpr } from "@takibi/protocol";
import { matchesQuery } from "@takibi/query";
import { assertJsonObject } from "@takibi/utility";
import { BadRequestError, LIST_PAGE_DEFAULT, LIST_PAGE_MAX, TakibiError } from "@takibi/api";
import { compileIndexedScanSql, createIndexCatalogTableSql } from "./index-sql";
import {
  extractIndexValues,
  resolveIndexedList,
  type IndexRegistry,
  type ResolvedIndexScan,
} from "./indexes";
import { compileQueryToSql } from "./sql-query";
import type { QueryExpr, StorageListOptions, WithMetadata } from "@takibi/shared-types";
import { TAKIBI_REVISION_KEY, TAKIBI_VERSION_KEY } from "@takibi/shared-types";
import { documentRevision, withDocumentRevision } from "./revision";
import type { StorageDriver, StorageListPlan, StoredDocument } from "./types";

type ListCursorV2 = {
  v: 2;
  collection: string;
  where: QueryExpr | null;
  id: string;
};

type ListCursorV3 = {
  v: 3;
  collection: string;
  where: QueryExpr | null;
  index: string;
  fields: readonly string[];
  orderField: string;
  direction: "asc" | "desc";
  values: readonly (string | number)[];
  id: string;
};

type ListCursor = ListCursorV2 | ListCursorV3;

const LIST_CHUNK_SIZE = 128;
const STORAGE_LAYOUT_VERSION = 4;
const EMPTY_INDEX_REGISTRY: IndexRegistry = {
  byCollection: new Map(),
  schemaVersions: new Map(),
};
const STORAGE_LAYOUT_KEY = "layout_version";
const MAX_FINITE_DOUBLE = 1.7976931348623157e308;

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
  limit: number;
  scan:
    | { kind: "id"; startAfter: string | undefined }
    | {
        kind: "index";
        resolved: ResolvedIndexScan;
        startAfter?: { values: readonly (string | number)[]; id: string };
      };
};

type LayoutRow = Record<string, SqlStorageValue> & {
  value: number;
};

type DocumentRow = Record<string, SqlStorageValue> & {
  id: string;
  created_at: string;
  updated_at: string;
  schema_version: number;
  revision: number;
  data: string;
};

export function createDurableObjectStorage(
  storage: DurableObjectStorage,
  registry: IndexRegistry = EMPTY_INDEX_REGISTRY,
): StorageDriver {
  initializeStorageLayout(storage);
  let operationQueue = Promise.resolve();
  const coordinate = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const createDriver = (transactionBound: boolean): StorageDriver => {
    const execute = <T>(operation: () => T | Promise<T>): Promise<T> =>
      transactionBound ? Promise.resolve().then(operation) : coordinate(operation);
    const driver: StorageDriver = {
      get(resource, id) {
        return execute(() => {
          const rows = storage.sql
            .exec<DocumentRow>(
              `SELECT id, created_at, updated_at, schema_version, revision, data
               FROM takibi_documents
               WHERE collection = ? AND id = ?`,
              resource,
              id,
            )
            .toArray();
          return rows[0] === undefined ? null : withDocumentRevision(rowToDocument(rows[0]));
        });
      },
      put(resource, doc) {
        return execute(() => {
          const encoded = encodeDocument(doc);
          storage.sql.exec(
            `INSERT INTO takibi_documents
               (collection, id, created_at, updated_at, schema_version, revision, data)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (collection, id) DO UPDATE SET
               created_at = excluded.created_at,
               updated_at = excluded.updated_at,
               schema_version = excluded.schema_version,
               revision = excluded.revision,
               data = excluded.data`,
            resource,
            doc.id,
            doc.createdAt,
            doc.updatedAt,
            encoded.schemaVersion,
            encoded.revision,
            encoded.data,
          );
        });
      },
      delete(resource, id) {
        return execute(
          () =>
            storage.sql
              .exec<{ id: string }>(
                `DELETE FROM takibi_documents
                 WHERE collection = ? AND id = ?
                 RETURNING id`,
                resource,
                id,
              )
              .toArray().length > 0,
        );
      },
      async list(resource, opts, plan) {
        const prepared = prepareList(resource, opts, registry);
        if (prepared.scan.kind === "index") {
          const readChunk = createSqlIndexChunkReader(storage.sql, resource, prepared, plan);
          return paginateIndex(
            prepared,
            prepared.scan.resolved,
            (startAfter, limit) => execute(() => readChunk(startAfter, limit)),
            plan,
          );
        }
        const readChunk = createSqlChunkReader(storage.sql, resource, prepared, plan);
        return paginate(
          prepared,
          (startAfter, limit) => execute(() => readChunk(startAfter, limit)),
          plan,
        );
      },
      transaction(callback) {
        if (transactionBound) {
          return callback(driver);
        }
        return coordinate(() => storage.transaction(() => callback(createDriver(true))));
      },
    };
    return driver;
  };
  return createDriver(false);
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
      if (version === 0) {
        createDocumentTable(storage.sql, "takibi_documents");
        createIndexCatalog(storage.sql);
        version = STORAGE_LAYOUT_VERSION;
      } else if (version === 1) {
        migrateVersionOneToTwo(storage.sql);
        version = 2;
      } else if (version === 2) {
        createIndexCatalog(storage.sql);
        version = 3;
      } else if (version === 3) {
        // Maintenance/staging tables are owned by the snapshot/maintenance
        // initializer, not this document/index layout.
        version = 4;
      } else {
        throw new TakibiError(
          "STORAGE_LAYOUT_VERSION",
          `No migration from Takibi storage layout version ${version}`,
          500,
        );
      }
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

function createIndexCatalog(sql: SqlStorage): void {
  sql.exec(createIndexCatalogTableSql());
}

function createDocumentTable(sql: SqlStorage, table: "takibi_documents" | "takibi_documents_v2") {
  sql.exec(
    `CREATE TABLE ${table} (
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
      PRIMARY KEY (collection, id)
    ) WITHOUT ROWID`,
  );
}

function migrateVersionOneToTwo(sql: SqlStorage): void {
  sql.exec("ALTER TABLE takibi_documents RENAME TO takibi_documents_v1");
  createDocumentTable(sql, "takibi_documents_v2");
  sql.exec(
    `INSERT INTO takibi_documents_v2
      (collection, id, created_at, updated_at, schema_version, revision, data)
     SELECT
       collection,
       id,
       created_at,
       updated_at,
       schema_version,
       CASE
         WHEN json_type(data, '$.rev') IN ('integer', 'real')
           AND json_extract(data, '$.rev') >= 1
           AND json_extract(data, '$.rev') <= ?
           AND (
             json_extract(data, '$.rev') >= 9007199254740992
             OR json_extract(data, '$.rev') = CAST(json_extract(data, '$.rev') AS INTEGER)
           )
         THEN CAST(json_extract(data, '$.rev') AS REAL)
         ELSE 1.0
       END,
       json_remove(data, '$.rev')
     FROM takibi_documents_v1`,
    MAX_FINITE_DOUBLE,
  );

  const oldCount = sql
    .exec<{ count: number }>("SELECT count(*) AS count FROM takibi_documents_v1")
    .one().count;
  const newCount = sql
    .exec<{ count: number }>("SELECT count(*) AS count FROM takibi_documents_v2")
    .one().count;
  const invalidCount = sql
    .exec<{ count: number }>(
      `SELECT count(*) AS count
       FROM takibi_documents_v2
       WHERE revision < 1
         OR revision > ?
         OR (
           revision < 9007199254740992
           AND revision <> CAST(revision AS INTEGER)
         )
         OR NOT json_valid(data)
         OR json_type(data) <> 'object'
         OR json_type(data, '$.rev') IS NOT NULL`,
      MAX_FINITE_DOUBLE,
    )
    .one().count;
  if (oldCount !== newCount || invalidCount !== 0) {
    throw new TakibiError(
      "STORAGE_LAYOUT_VERSION",
      "Takibi storage layout migration validation failed",
      500,
    );
  }

  sql.exec("DROP TABLE takibi_documents_v1");
  sql.exec("ALTER TABLE takibi_documents_v2 RENAME TO takibi_documents");
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
        `SELECT id, created_at, updated_at, schema_version, revision, data
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

function createSqlIndexChunkReader(
  sql: SqlStorage,
  resource: string,
  prepared: PreparedList,
  _plan: StorageListPlan | undefined,
): IndexReadChunk {
  if (prepared.scan.kind !== "index") {
    throw new TakibiError("INVALID_DOCUMENT", "Indexed scan required", 500);
  }
  const scan = prepared.scan.resolved;
  return (startAfter, limit) => {
    const compiled = compileIndexedScanSql(resource, scan, {
      ...(startAfter === undefined ? {} : { startAfter }),
      ...(prepared.where === undefined ? {} : { residual: prepared.where }),
      limit,
    });
    return sql
      .exec<DocumentRow>(compiled.sql, ...compiled.bindings)
      .toArray()
      .map((row) => ({ id: row.id, document: withDocumentRevision(rowToDocument(row)) }));
  };
}

function encodeDocument(document: StoredDocument): {
  schemaVersion: number;
  revision: number;
  data: string;
} {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    [TAKIBI_VERSION_KEY]: rawVersion,
    [TAKIBI_REVISION_KEY]: _rawRevision,
    ...data
  } = document;
  assertJsonObject(data, {
    subject: "Collection document",
    error: (message) => new TakibiError("INVALID_DOCUMENT", message, 500),
  });
  const schemaVersion = rawVersion ?? 0;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new TakibiError(
      "MIGRATION_VERSION",
      "Stored document has an invalid migration version",
      500,
    );
  }
  const revision = documentRevision(document);
  return { schemaVersion, revision, data: JSON.stringify(data) };
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
    [TAKIBI_REVISION_KEY]: row.revision,
    ...(row.schema_version === 0 ? {} : { [TAKIBI_VERSION_KEY]: row.schema_version }),
  });
}

function prepareList(
  resource: string,
  opts: StorageListOptions | undefined,
  registry: IndexRegistry,
): PreparedList {
  let where: QueryExpr | undefined;
  try {
    where = opts?.where === undefined ? undefined : normalizeQueryExpr(opts.where);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : "Invalid query");
  }

  if (
    opts?.limit !== undefined &&
    (typeof opts.limit !== "number" || !Number.isInteger(opts.limit) || opts.limit < 1)
  ) {
    throw new BadRequestError("Invalid list limit");
  }

  const resolved = resolveIndexedList(resource, { ...opts, where }, registry);
  const cursor = opts?.cursor === undefined ? undefined : decodeCursor(opts.cursor);
  const limit = Math.min(opts?.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);

  if (resolved === undefined) {
    if (cursor !== undefined && cursor.v !== 2) {
      throw new BadRequestError("Cursor does not match this collection and query");
    }
    if (
      cursor !== undefined &&
      (cursor.collection !== resource || !sameQuery(cursor.where, where))
    ) {
      throw new BadRequestError("Cursor does not match this collection and query");
    }
    return {
      collection: resource,
      where,
      limit,
      scan: { kind: "id", startAfter: cursor?.id },
    };
  }

  if (cursor !== undefined) {
    if (cursor.v !== 3 || !sameIndexedCursor(cursor, resource, where, resolved)) {
      throw new BadRequestError("Cursor does not match this collection and query");
    }
  }

  return {
    collection: resource,
    where,
    limit,
    scan: {
      kind: "index",
      resolved,
      ...(cursor && cursor.v === 3 ? { startAfter: { values: cursor.values, id: cursor.id } } : {}),
    },
  };
}

async function paginate(
  prepared: PreparedList,
  readChunk: ReadChunk,
  plan: StorageListPlan | undefined,
): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }> {
  const page: WithMetadata<Record<string, unknown>>[] = [];
  let startAfter = prepared.scan.kind === "id" ? prepared.scan.startAfter : undefined;

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
          nextCursor: encodeCursor({
            v: 2,
            collection: prepared.collection,
            where: prepared.where ?? null,
            id: last.id,
          }),
        };
      }
      page.push(document);
    }

    if (chunk.length < LIST_CHUNK_SIZE) break;
  }

  return { items: page };
}

type IndexReadChunk = (
  startAfter: { values: readonly (string | number)[]; id: string } | undefined,
  limit: number,
) => Promise<ScanItem[]> | ScanItem[];

async function paginateIndex(
  prepared: PreparedList,
  resolved: ResolvedIndexScan,
  readChunk: IndexReadChunk,
  plan: StorageListPlan | undefined,
): Promise<{ items: WithMetadata<Record<string, unknown>>[]; nextCursor?: string }> {
  const page: WithMetadata<Record<string, unknown>>[] = [];
  let startAfter = prepared.scan.kind === "index" ? prepared.scan.startAfter : undefined;

  while (true) {
    const chunk = await readChunk(startAfter, LIST_CHUNK_SIZE);
    if (chunk.length === 0) break;

    for (const item of chunk) {
      const document = plan ? await plan.transform(item.document) : item.document;
      const values = extractIndexValues(document, resolved.index.fields);
      if (values === undefined) continue;
      startAfter = { values, id: document.id };
      if (prepared.where && !matchesQuery(document, prepared.where)) continue;
      if (page.length === prepared.limit) {
        const last = page.at(-1)!;
        const lastValues = extractIndexValues(last, resolved.index.fields);
        if (lastValues === undefined) {
          throw new TakibiError(
            "INVALID_DOCUMENT",
            "Indexed document is missing index fields",
            500,
          );
        }
        return {
          items: page,
          nextCursor: encodeCursor({
            v: 3,
            collection: prepared.collection,
            where: prepared.where ?? null,
            index: resolved.index.name,
            fields: resolved.index.fields,
            orderField: resolved.orderField,
            direction: resolved.direction,
            values: lastValues,
            id: last.id,
          }),
        };
      }
      page.push(document);
    }

    if (chunk.length < LIST_CHUNK_SIZE) break;
  }

  return { items: page };
}

function sameQuery(cursorWhere: QueryExpr | null, where: QueryExpr | undefined): boolean {
  return JSON.stringify(cursorWhere) === JSON.stringify(where ?? null);
}

function sameIndexedCursor(
  cursor: ListCursorV3,
  collection: string,
  where: QueryExpr | undefined,
  resolved: ResolvedIndexScan,
): boolean {
  return (
    cursor.collection === collection &&
    sameQuery(cursor.where, where) &&
    cursor.index === resolved.index.name &&
    cursor.orderField === resolved.orderField &&
    cursor.direction === resolved.direction &&
    cursor.fields.length === resolved.index.fields.length &&
    cursor.fields.every((field, index) => field === resolved.index.fields[index])
  );
}

function encodeCursor(cursor: ListCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const chunkSize = 8192;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(token: string): ListCursor {
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
    if (value.v === 2) {
      assertExactKeys(value, ["v", "collection", "where", "id"]);
      if (
        typeof value.collection !== "string" ||
        value.collection.length === 0 ||
        typeof value.id !== "string" ||
        value.id.length === 0
      ) {
        throw new Error("Invalid cursor fields");
      }
      const where = value.where === null ? null : normalizeQueryExpr(value.where);
      return { v: 2, collection: value.collection, where, id: value.id };
    }
    if (value.v === 3) {
      assertExactKeys(value, [
        "v",
        "collection",
        "where",
        "index",
        "fields",
        "orderField",
        "direction",
        "values",
        "id",
      ]);
      if (
        typeof value.collection !== "string" ||
        value.collection.length === 0 ||
        typeof value.index !== "string" ||
        value.index.length === 0 ||
        typeof value.orderField !== "string" ||
        value.orderField.length === 0 ||
        (value.direction !== "asc" && value.direction !== "desc") ||
        typeof value.id !== "string" ||
        value.id.length === 0 ||
        !Array.isArray(value.fields) ||
        !value.fields.every((field) => typeof field === "string") ||
        !Array.isArray(value.values) ||
        !value.values.every((entry) => typeof entry === "string" || typeof entry === "number")
      ) {
        throw new Error("Invalid cursor fields");
      }
      const where = value.where === null ? null : normalizeQueryExpr(value.where);
      return {
        v: 3,
        collection: value.collection,
        where,
        index: value.index,
        fields: value.fields,
        orderField: value.orderField,
        direction: value.direction,
        values: value.values,
        id: value.id,
      };
    }
    throw new Error("Invalid cursor version");
  } catch {
    throw new BadRequestError("Invalid list cursor");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("Invalid cursor fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
