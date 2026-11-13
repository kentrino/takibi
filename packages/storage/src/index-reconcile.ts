import {
  compileCreateIndexSql,
  compileDropIndexSql,
  physicalIndexName,
  type IndexCatalogRow,
} from "./index-sql";
import {
  assertDocumentIndexFields,
  collectionSchemaVersion,
  compileIndexRegistry,
  type IndexedCollectionSource,
  type IndexRegistry,
} from "./indexes";
import type { SqlExecutor, SqlStatementExecutor } from "./sql-executor";
import type { SqliteStorage } from "./storage";
import type { StorageDriver } from "./types";

const BACKFILL_PAGE_SIZE = 200;

type CatalogRecord = IndexCatalogRow;
type DesiredCatalogRecord = CatalogRecord & { definition: IndexedCollectionSource };

export async function backfillIndexedCollections(
  collections: Record<string, IndexedCollectionSource>,
  storage: StorageDriver,
): Promise<void> {
  for (const [collection, definition] of Object.entries(collections)) {
    if (!hasIndexes(definition)) continue;
    await backfillCollection(definition, storage, collection);
  }
}

export type ReconcileIndexesOptions = {
  /** Reads documents for the backfill check (default: the opened storage). */
  reader?: StorageDriver;
  collections: Record<string, IndexedCollectionSource>;
  registry?: IndexRegistry;
};

/**
 * Bring the physical indexes and the index catalog of an opened storage in
 * line with `collections`. Before building an index, every document of its
 * collection is read through `reader` (default: `storage`; pass a migrating
 * view so documents are checked in their current shape) and must carry the
 * indexed fields.
 *
 * Atomic: every index drop, index build, and catalog write happens in one
 * transaction, after all checks passed, so a failure at any point leaves the
 * catalog and the physical indexes as they were. Run it while nothing else
 * changes the catalog or indexes (Takibi runs it during startup).
 */
export function reconcileCollectionIndexes(
  args: ReconcileIndexesOptions & { storage: SqliteStorage },
): Promise<void> {
  const { storage, ...options } = args;
  return storage.reconcileIndexes(options);
}

/** `reconcileCollectionIndexes` on the executor `openSqliteStorage` opened; internal to this package. */
export async function reconcileIndexes(
  sql: SqlExecutor,
  args: ReconcileIndexesOptions & { reader: StorageDriver },
): Promise<void> {
  const registry = args.registry ?? compileIndexRegistry(args.collections);
  const desired = desiredCatalog(args.collections, registry);
  const catalog = await readCatalog(sql);
  const physicalPresent = await listPhysicalTakibiIndexes(sql);

  // Plan every change before making any.
  const desiredByPhysical = new Map(desired.map((row) => [row.physicalName, row]));
  const catalogByKey = new Map(
    catalog.map((row) => [catalogKey(row.collection, row.publicName), row]),
  );
  const staleCatalog: CatalogRecord[] = [];
  for (const existing of catalog) {
    const next = desired.find(
      (row) => row.collection === existing.collection && row.publicName === existing.publicName,
    );
    if (next && next.physicalName === existing.physicalName) continue;
    staleCatalog.push(existing);
    catalogByKey.delete(catalogKey(existing.collection, existing.publicName));
  }
  const orphanIndexes = physicalPresent.filter(
    (name) => !desiredByPhysical.has(name) && !catalog.some((row) => row.physicalName === name),
  );
  const builds = desired.filter((row) => {
    const current = catalogByKey.get(catalogKey(row.collection, row.publicName));
    return (
      current === undefined ||
      current.schemaVersion !== row.schemaVersion ||
      !sameFields(current.fields, row.fields) ||
      !physicalPresent.includes(row.physicalName)
    );
  });
  if (staleCatalog.length === 0 && orphanIndexes.length === 0 && builds.length === 0) return;

  // The backfill check reads through the storage driver, which runs on this
  // executor, so it must finish before the transaction opens: a driver call
  // from inside it would wait behind the transaction forever.
  const backfilled = new Set<string>();
  for (const row of builds) {
    if (backfilled.has(row.collection)) continue;
    await backfillCollection(row.definition, args.reader, row.collection);
    backfilled.add(row.collection);
  }

  // SQLite runs CREATE INDEX and DROP INDEX transactionally, so the catalog
  // and the physical indexes change together or not at all.
  await sql.transaction(async (tx) => {
    for (const existing of staleCatalog) {
      await tx.exec(compileDropIndexSql(existing.physicalName));
      await tx.exec(
        "DELETE FROM takibi_index_catalog WHERE physical_name = ?",
        existing.physicalName,
      );
    }
    for (const name of orphanIndexes) {
      await tx.exec(compileDropIndexSql(name));
    }
    for (const row of builds) {
      await tx.exec(compileCreateIndexSql(row));
      await writeCatalog(tx, row);
    }
  });
  // A statistics hint once the indexes changed. The change above is already
  // committed and nothing depends on the hint, and some servers refuse it
  // (sqld rejects `PRAGMA optimize` as an unsupported statement), so its
  // failure does not fail reconciliation.
  await sql.exec("PRAGMA optimize").catch(() => undefined);
}

function hasIndexes(definition: IndexedCollectionSource): boolean {
  return definition.indexes !== undefined && Object.keys(definition.indexes).length > 0;
}

async function backfillCollection(
  definition: IndexedCollectionSource,
  storage: StorageDriver,
  collection: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await storage.list(collection, {
      limit: BACKFILL_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const document of page.items) {
      assertDocumentIndexFields(definition, collection, document);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

function desiredCatalog(
  collections: Record<string, IndexedCollectionSource>,
  registry: IndexRegistry,
): DesiredCatalogRecord[] {
  const rows: DesiredCatalogRecord[] = [];
  for (const [collection, indexes] of registry.byCollection) {
    const definition = collections[collection];
    if (!definition) {
      throw new Error(`Missing collection definition for ${collection}`);
    }
    const schemaVersion =
      registry.schemaVersions.get(collection) ?? collectionSchemaVersion(definition);
    for (const compiled of indexes.values()) {
      rows.push({
        physicalName: physicalIndexName(collection, compiled.name, compiled.fields),
        collection,
        publicName: compiled.name,
        fields: compiled.fields,
        schemaVersion,
        definition,
      });
    }
  }
  return rows;
}

async function readCatalog(sql: SqlExecutor): Promise<CatalogRecord[]> {
  const { rows } = await sql.read<{
    physical_name: string;
    collection: string;
    public_name: string;
    fields_json: string;
    schema_version: number;
  }>(
    "SELECT physical_name, collection, public_name, fields_json, schema_version FROM takibi_index_catalog",
  );
  return rows.map((row) => ({
    physicalName: row.physical_name,
    collection: row.collection,
    publicName: row.public_name,
    fields: parseCatalogFields(row.fields_json, row.collection, row.public_name),
    schemaVersion: row.schema_version,
  }));
}

function parseCatalogFields(json: string, collection: string, publicName: string): string[] {
  const message = `Invalid index catalog fields: ${collection}.${publicName}`;
  let fields: unknown;
  try {
    fields = JSON.parse(json);
  } catch (cause) {
    throw new Error(message, { cause });
  }
  if (
    !Array.isArray(fields) ||
    !fields.every((field): field is string => typeof field === "string")
  ) {
    throw new Error(message);
  }
  return fields;
}

async function writeCatalog(sql: SqlStatementExecutor, row: CatalogRecord): Promise<void> {
  await sql.exec(
    `INSERT INTO takibi_index_catalog
       (physical_name, collection, public_name, fields_json, schema_version)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (physical_name) DO UPDATE SET
       collection = excluded.collection,
       public_name = excluded.public_name,
       fields_json = excluded.fields_json,
       schema_version = excluded.schema_version`,
    row.physicalName,
    row.collection,
    row.publicName,
    JSON.stringify(row.fields),
    row.schemaVersion,
  );
}

async function listPhysicalTakibiIndexes(sql: SqlExecutor): Promise<string[]> {
  const { rows } = await sql.read<{ name: string }>(
    `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'takibi_idx_%'`,
  );
  return rows.map((row) => row.name);
}

function catalogKey(collection: string, publicName: string): string {
  return `${collection}\0${publicName}`;
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}
