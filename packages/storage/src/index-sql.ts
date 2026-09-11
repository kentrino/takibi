import type { IndexRangePlan, ResolvedIndexScan } from "./indexes";
import type { QueryScalar } from "@takibi/shared-types";
import { compileQueryToSql, type SqlBinding, type SqlPredicate } from "./sql-query";

const METADATA_COLUMNS: Readonly<Record<string, string>> = {
  id: "id",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export type IndexCatalogRow = {
  physicalName: string;
  collection: string;
  publicName: string;
  fields: readonly string[];
  schemaVersion: number;
};

export function physicalIndexName(
  collection: string,
  publicName: string,
  fields: readonly string[],
): string {
  return `takibi_idx_${fnv1aHex(`${collection}\0${publicName}\0${fields.join("\0")}`)}`;
}

export function indexColumnExpression(field: string): string {
  const metadata = METADATA_COLUMNS[field];
  if (metadata !== undefined) return metadata;
  return `json_extract(data, ${sqlString(jsonPath(field))})`;
}

export function compileCreateIndexSql(row: IndexCatalogRow): string {
  const columns = [...row.fields, "id"].map(indexColumnExpression).join(", ");
  return `CREATE INDEX IF NOT EXISTS ${row.physicalName} ON takibi_documents (${columns}) WHERE collection = ${sqlString(row.collection)}`;
}

export function compileDropIndexSql(physicalName: string): string {
  assertPhysicalIndexName(physicalName);
  return `DROP INDEX IF EXISTS ${physicalName}`;
}

export function compileIndexedScanSql(
  collection: string,
  scan: ResolvedIndexScan,
  args: {
    startAfter?: { values: readonly (string | number)[]; id: string };
    residual?: Parameters<typeof compileQueryToSql>[0];
    limit: number;
  },
): SqlPredicate {
  const scanFields = scanFieldsFrom(scan);
  const clauses = ["collection = ?"];
  const bindings: SqlBinding[] = [collection];

  for (const equality of scan.range.equalities) {
    clauses.push(`${indexColumnExpression(equality.field)} = ?`);
    bindings.push(asBinding(equality.value));
  }

  const rangePredicate = compileRangePredicate(scan.range);
  if (rangePredicate) {
    clauses.push(rangePredicate.sql);
    bindings.push(...rangePredicate.bindings);
  }

  if (args.startAfter) {
    const orderIndex = Math.max(scan.index.fields.indexOf(scan.orderField), 0);
    const keyset = compileKeysetPredicate(scanFields, scan.direction, {
      values: args.startAfter.values.slice(orderIndex),
      id: args.startAfter.id,
    });
    clauses.push(keyset.sql);
    bindings.push(...keyset.bindings);
  }

  if (args.residual) {
    const residual = compileQueryToSql(args.residual);
    clauses.push(residual.sql);
    bindings.push(...residual.bindings);
  }

  const order = scanFields
    .map((field) => `${indexColumnExpression(field)} ${scan.direction.toUpperCase()}`)
    .join(", ");

  return {
    sql: `SELECT id, created_at, updated_at, schema_version, revision, data
         FROM takibi_documents
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
    bindings: [...bindings, args.limit],
  };
}

export function createIndexCatalogTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS takibi_index_catalog (
      physical_name TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      public_name TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL
    ) WITHOUT ROWID`;
}

function scanFieldsFrom(scan: ResolvedIndexScan): readonly string[] {
  const orderIndex = scan.index.fields.indexOf(scan.orderField);
  return [...scan.index.fields.slice(Math.max(orderIndex, 0)), "id"];
}

function compileRangePredicate(plan: IndexRangePlan): SqlPredicate | undefined {
  if (plan.rangeField === undefined || plan.range === undefined) return undefined;
  const expr = indexColumnExpression(plan.rangeField);
  const clauses: string[] = [];
  const bindings: SqlBinding[] = [];
  const range = plan.range;
  if (range.gt !== undefined) {
    clauses.push(`${expr} > ?`);
    bindings.push(asBinding(range.gt));
  }
  if (range.gte !== undefined) {
    clauses.push(`${expr} >= ?`);
    bindings.push(asBinding(range.gte));
  }
  if (range.lt !== undefined) {
    clauses.push(`${expr} < ?`);
    bindings.push(asBinding(range.lt));
  }
  if (range.lte !== undefined) {
    clauses.push(`${expr} <= ?`);
    bindings.push(asBinding(range.lte));
  }
  if (clauses.length === 0) return undefined;
  return { sql: `(${clauses.join(" AND ")})`, bindings };
}

function compileKeysetPredicate(
  fields: readonly string[],
  direction: "asc" | "desc",
  cursor: { values: readonly (string | number)[]; id: string },
): SqlPredicate {
  const expressions = fields.map(indexColumnExpression);
  const operator = direction === "asc" ? ">" : "<";
  const values = [...cursor.values, cursor.id];
  return {
    sql: `(${expressions.join(", ")}) ${operator} (${expressions.map(() => "?").join(", ")})`,
    bindings: values.map(asBinding),
  };
}

function jsonPath(field: string): string {
  if (field.includes("\0")) {
    throw new Error("Index field must not contain NUL");
  }
  return `$."${field.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asBinding(value: QueryScalar | string | number): SqlBinding {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function assertPhysicalIndexName(name: string): void {
  if (!/^takibi_idx_[0-9a-f]+$/.test(name)) {
    throw new Error("Invalid physical index name");
  }
}

function fnv1aHex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let high = 0x811c9dc5;
  let low = 0x811c9dc5;
  for (const byte of bytes) {
    high ^= byte;
    high = Math.imul(high, 0x01000193);
    low ^= byte ^ 0xa5;
    low = Math.imul(low, 0x01000193);
  }
  return `${toHex(high >>> 0)}${toHex(low >>> 0)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(8, "0");
}
