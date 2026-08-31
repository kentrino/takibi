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
import type { InternalLogger } from "./logging";
import type { StorageDriver } from "./types";

const BACKFILL_PAGE_SIZE = 200;

type CatalogRecord = IndexCatalogRow;

export async function backfillIndexedCollections(
  collections: Record<string, IndexedCollectionSource>,
  storage: StorageDriver,
  logger?: InternalLogger,
): Promise<void> {
  void logger;
  for (const [collection, definition] of Object.entries(collections)) {
    if (!hasIndexes(definition)) continue;
    await backfillCollection(definition, storage, collection);
  }
}

export async function reconcileCollectionIndexes(args: {
  sql: SqlStorage;
  collections: Record<string, IndexedCollectionSource>;
  storage: StorageDriver;
  registry?: IndexRegistry;
  logger?: InternalLogger;
}): Promise<void> {
  const registry = args.registry ?? compileIndexRegistry(args.collections);
  const desired = desiredCatalog(args.collections, registry);
  const catalog = readCatalog(args.sql);
  const physicalPresent = listPhysicalTakibiIndexes(args.sql);
  let ddl = false;

  const desiredByPhysical = new Map(desired.map((row) => [row.physicalName, row]));
  const catalogByKey = new Map(
    catalog.map((row) => [catalogKey(row.collection, row.publicName), row]),
  );

  for (const existing of catalog) {
    const next = desired.find(
      (row) => row.collection === existing.collection && row.publicName === existing.publicName,
    );
    if (next && next.physicalName === existing.physicalName) continue;
    args.sql.exec(compileDropIndexSql(existing.physicalName));
    args.sql.exec(
      "DELETE FROM takibi_index_catalog WHERE physical_name = ?",
      existing.physicalName,
    );
    ddl = true;
    catalogByKey.delete(catalogKey(existing.collection, existing.publicName));
  }

  for (const name of physicalPresent) {
    if (!desiredByPhysical.has(name) && !catalog.some((row) => row.physicalName === name)) {
      args.sql.exec(compileDropIndexSql(name));
      ddl = true;
    }
  }

  const backfilled = new Set<string>();
  for (const row of desired) {
    const current = catalogByKey.get(catalogKey(row.collection, row.publicName));
    const needsBuild =
      current === undefined ||
      current.schemaVersion !== row.schemaVersion ||
      !sameFields(current.fields, row.fields) ||
      !physicalPresent.includes(row.physicalName);

    if (needsBuild) {
      if (!backfilled.has(row.collection)) {
        const definition = args.collections[row.collection];
        if (!definition) {
          throw new Error(`Missing collection definition for ${row.collection}`);
        }
        await backfillCollection(definition, args.storage, row.collection);
        backfilled.add(row.collection);
      }
      args.sql.exec(compileCreateIndexSql(row));
      writeCatalog(args.sql, row);
      ddl = true;
    }
  }

  if (ddl) {
    args.sql.exec("PRAGMA optimize");
  }
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
): CatalogRecord[] {
  const rows: CatalogRecord[] = [];
  for (const [collection, indexes] of registry.byCollection) {
    const schemaVersion =
      registry.schemaVersions.get(collection) ?? collectionSchemaVersion(collections[collection]!);
    for (const compiled of indexes.values()) {
      rows.push({
        physicalName: physicalIndexName(collection, compiled.name, compiled.fields),
        collection,
        publicName: compiled.name,
        fields: compiled.fields,
        schemaVersion,
      });
    }
  }
  return rows;
}

function readCatalog(sql: SqlStorage): CatalogRecord[] {
  return sql
    .exec<{
      physical_name: string;
      collection: string;
      public_name: string;
      fields_json: string;
      schema_version: number;
    }>(
      "SELECT physical_name, collection, public_name, fields_json, schema_version FROM takibi_index_catalog",
    )
    .toArray()
    .map((row) => ({
      physicalName: row.physical_name,
      collection: row.collection,
      publicName: row.public_name,
      fields: JSON.parse(row.fields_json) as string[],
      schemaVersion: row.schema_version,
    }));
}

function writeCatalog(sql: SqlStorage, row: CatalogRecord): void {
  sql.exec(
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

function listPhysicalTakibiIndexes(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'takibi_idx_%'`,
    )
    .toArray()
    .map((row) => row.name);
}

function catalogKey(collection: string, publicName: string): string {
  return `${collection}\0${publicName}`;
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field, index) => field === right[index]);
}
