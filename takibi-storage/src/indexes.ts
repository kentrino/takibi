import {
  BadRequestError,
  INDEXABLE_METADATA_FIELDS,
  TakibiError,
  type CollectionDefinition,
} from "@takibi/takibi-api";
import { normalizeOrderBy } from "@takibi/takibi-protocol";
import type {
  OrderExpr,
  QueryExpr,
  QueryScalar,
  StorageListOptions,
  StorageOrderBy,
} from "@takibi/takibi-shared-types";
import {
  RESERVED_DOCUMENT_DATA_KEYS,
  TAKIBI_REVISION_KEY,
  TAKIBI_VERSION_KEY,
} from "@takibi/takibi-shared-types";

const INDEX_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METADATA_FIELDS = new Set<string>(INDEXABLE_METADATA_FIELDS);

export type CompiledIndex = {
  name: string;
  fields: readonly string[];
};

export type IndexRegistry = {
  byCollection: ReadonlyMap<string, ReadonlyMap<string, CompiledIndex>>;
  schemaVersions: ReadonlyMap<string, number>;
};

export type IndexRangeBound = {
  gt?: QueryScalar;
  gte?: QueryScalar;
  lt?: QueryScalar;
  lte?: QueryScalar;
};

export type IndexRangePlan = {
  equalities: { field: string; value: QueryScalar }[];
} & ({ rangeField?: never; range?: never } | { rangeField: string; range?: IndexRangeBound });

export type ResolvedIndexScan = {
  index: CompiledIndex;
  orderField: string;
  direction: "asc" | "desc";
  range: IndexRangePlan;
};

export type IndexedCollectionSource = {
  indexes?: Readonly<Record<string, readonly string[]>>;
  migrations?: CollectionDefinition["migrations"];
  schema?: unknown;
  accessPolicy?: unknown;
  unique?: unknown;
  seed?: unknown;
};

export function collectionSchemaVersion(definition: IndexedCollectionSource): number {
  const migrations = definition.migrations;
  return (migrations?.base ?? 0) + (migrations?.steps.length ?? 0);
}

export function compileIndexRegistry(
  collections: Record<string, IndexedCollectionSource>,
): IndexRegistry {
  const byCollection = new Map<string, ReadonlyMap<string, CompiledIndex>>();
  const schemaVersions = new Map<string, number>();
  for (const [collection, definition] of Object.entries(collections)) {
    schemaVersions.set(collection, collectionSchemaVersion(definition));
    const compiled = new Map<string, CompiledIndex>();
    for (const [name, fields] of Object.entries(definition.indexes ?? {})) {
      const tuple = Array.isArray(fields)
        ? fields.filter((field) => typeof field === "string")
        : [];
      compiled.set(name, { name, fields: Object.freeze(tuple) });
    }
    if (compiled.size > 0) byCollection.set(collection, compiled);
  }
  return { byCollection, schemaVersions };
}

export function assertCollectionIndexes(
  definition: CollectionDefinition,
  collection: string,
): void {
  const indexes = definition.indexes;
  if (indexes === undefined) return;
  if (!isPlainRecord(indexes)) {
    throw invalidCollection(collection, "indexes must be a plain object");
  }

  for (const key of Reflect.ownKeys(indexes)) {
    if (typeof key !== "string") {
      throw invalidCollection(collection, "index names must be strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(indexes, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalidCollection(collection, "indexes must be enumerable data properties");
    }
    if (!INDEX_NAME_PATTERN.test(key)) {
      throw invalidCollection(collection, `invalid index name: ${key}`);
    }
    assertIndexFields(collection, key, descriptor.value);
  }
}

export function assertDocumentIndexFields(
  definition: IndexedCollectionSource,
  collection: string,
  document: Readonly<Record<string, unknown>>,
): void {
  for (const [name, fields] of Object.entries(definition.indexes ?? {})) {
    for (const field of fields as readonly string[]) {
      const value = document[field];
      if (!isIndexScalar(value)) {
        throw new TakibiError(
          "INVALID_DOCUMENT",
          `${collection}: index ${name} field ${field} must be a string or finite number`,
          500,
        );
      }
    }
  }
}

export function resolveIndexedList(
  collection: string,
  opts: StorageListOptions | undefined,
  registry: IndexRegistry,
): ResolvedIndexScan | undefined {
  if (opts?.orderBy !== undefined && (opts.index === undefined || opts.index === "")) {
    throw new BadRequestError("orderBy requires index");
  }
  if (opts?.index === undefined) return undefined;

  const indexes = registry.byCollection.get(collection);
  const compiled = indexes?.get(opts.index);
  if (!compiled) {
    throw new BadRequestError(`Unknown index: ${opts.index}`);
  }

  const orderBy = normalizeListOrderBy(opts.orderBy, compiled);
  const orderIndex = compiled.fields.indexOf(orderBy.field);
  if (orderIndex < 0) {
    throw new BadRequestError(`Order field is not part of index ${compiled.name}`);
  }

  const prefix = compiled.fields.slice(0, orderIndex);
  for (const field of prefix) {
    if (impliedEqualityValue(opts.where, field) === undefined) {
      throw new BadRequestError(
        `Index ${compiled.name} requires equality on ${field} before ordering by ${orderBy.field}`,
      );
    }
  }

  return {
    index: compiled,
    orderField: orderBy.field,
    direction: orderBy.direction,
    range: planIndexRange(compiled.fields, opts.where),
  };
}

export function planIndexRange(
  fields: readonly string[],
  where: QueryExpr | undefined,
): IndexRangePlan {
  const equalities: { field: string; value: QueryScalar }[] = [];

  for (const field of fields) {
    const equality = impliedEqualityValue(where, field);
    if (equality !== undefined) {
      equalities.push({ field, value: equality });
      continue;
    }
    const range = extractRangeBounds(where, field);
    return {
      equalities,
      rangeField: field,
      ...(range === undefined ? {} : { range }),
    };
  }

  return { equalities };
}

export function impliedEqualityValue(
  expression: QueryExpr | undefined,
  field: string,
): QueryScalar | undefined {
  if (!expression) return undefined;
  if ("field" in expression) {
    return expression.field === field && expression.op === "eq" ? expression.value : undefined;
  }
  if (expression.op === "and") {
    const seen = new Set<string>();
    let found: QueryScalar | undefined;
    for (const operand of expression.operands) {
      const value = impliedEqualityValue(operand, field);
      if (value === undefined) continue;
      const key = JSON.stringify(value);
      if (found === undefined) {
        found = value;
        seen.add(key);
      } else if (!seen.has(key)) {
        return undefined;
      }
    }
    return found;
  }
  if (expression.op === "or") {
    const values = expression.operands.map((operand) => impliedEqualityValue(operand, field));
    if (values.some((value) => value === undefined)) return undefined;
    const first = JSON.stringify(values[0]);
    return values.every((value) => JSON.stringify(value) === first) ? values[0] : undefined;
  }
  return undefined;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftBytes[index]! - rightBytes[index]!;
    if (delta !== 0) return delta;
  }
  return leftBytes.length - rightBytes.length;
}

export function compareIndexValue(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "string" && typeof right === "string") {
    return compareUtf8(left, right);
  }
  return typeof left === "number" ? -1 : 1;
}

export function compareIndexTuple(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
  direction: "asc" | "desc" = "asc",
): number {
  const sign = direction === "asc" ? 1 : -1;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = compareIndexValue(left[index]!, right[index]!);
    if (delta !== 0) return delta * sign;
  }
  return (left.length - right.length) * sign;
}

export function extractIndexValues(
  document: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): (string | number)[] | undefined {
  const values: (string | number)[] = [];
  for (const field of fields) {
    const value = document[field];
    if (!isIndexScalar(value)) return undefined;
    values.push(value);
  }
  return values;
}

export function compareDocumentIndexOrder(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  direction: "asc" | "desc",
): number {
  const leftValues = extractIndexValues(left, fields);
  const rightValues = extractIndexValues(right, fields);
  if (leftValues === undefined || rightValues === undefined) {
    if (leftValues === undefined && rightValues === undefined) {
      return compareUtf8(indexDocumentId(left), indexDocumentId(right));
    }
    return leftValues === undefined ? 1 : -1;
  }
  const fieldOrder = compareIndexTuple(leftValues, rightValues, direction);
  if (fieldOrder !== 0) return fieldOrder;
  return (
    compareUtf8(indexDocumentId(left), indexDocumentId(right)) * (direction === "asc" ? 1 : -1)
  );
}

function indexDocumentId(document: Readonly<Record<string, unknown>>): string {
  return typeof document.id === "string" ? document.id : "";
}

export function afterIndexCursor(
  values: readonly (string | number)[],
  id: string,
  cursorValues: readonly (string | number)[],
  cursorId: string,
  direction: "asc" | "desc",
): boolean {
  const tuple = compareIndexTuple([...values, id], [...cursorValues, cursorId], direction);
  return tuple > 0;
}

export function matchesIndexRange(
  document: Readonly<Record<string, unknown>>,
  plan: IndexRangePlan,
): boolean {
  for (const equality of plan.equalities) {
    if (document[equality.field] !== equality.value) return false;
  }
  if (plan.rangeField === undefined || plan.range === undefined) return true;
  const value = document[plan.rangeField];
  if (!isIndexScalar(value)) return false;
  return matchesRangeBound(value, plan.range);
}

function matchesRangeBound(value: string | number, range: IndexRangeBound): boolean {
  if (range.gt !== undefined && !isGreater(value, range.gt, false)) return false;
  if (range.gte !== undefined && !isGreater(value, range.gte, true)) return false;
  if (range.lt !== undefined && !isLess(value, range.lt, false)) return false;
  if (range.lte !== undefined && !isLess(value, range.lte, true)) return false;
  return true;
}

function isGreater(actual: string | number, bound: QueryScalar, inclusive: boolean): boolean {
  if (!isIndexScalar(bound) || typeof actual !== typeof bound) return false;
  const delta = compareIndexValue(actual, bound);
  return inclusive ? delta >= 0 : delta > 0;
}

function isLess(actual: string | number, bound: QueryScalar, inclusive: boolean): boolean {
  if (!isIndexScalar(bound) || typeof actual !== typeof bound) return false;
  const delta = compareIndexValue(actual, bound);
  return inclusive ? delta <= 0 : delta < 0;
}

function extractRangeBounds(
  expression: QueryExpr | undefined,
  field: string,
): IndexRangeBound | undefined {
  if (!expression) return undefined;
  const parts = flattenAnd(expression);
  if (parts.some((part) => mentionsFieldUnsafely(part, field))) return undefined;

  const range: IndexRangeBound = {};
  let found = false;
  for (const part of parts) {
    if (
      !("field" in part) ||
      part.field !== field ||
      (part.op !== "gt" && part.op !== "gte" && part.op !== "lt" && part.op !== "lte")
    ) {
      continue;
    }
    if (part.op === "gt") range.gt = part.value;
    if (part.op === "gte") range.gte = part.value;
    if (part.op === "lt") range.lt = part.value;
    if (part.op === "lte") range.lte = part.value;
    found = true;
  }
  return found ? range : undefined;
}

function flattenAnd(expression: QueryExpr): QueryExpr[] {
  return expression.op === "and" ? expression.operands.flatMap(flattenAnd) : [expression];
}

function mentionsFieldUnsafely(expression: QueryExpr, field: string): boolean {
  if (expression.op === "or" || expression.op === "not") {
    return queryMentionsField(expression, field);
  }
  return false;
}

function queryMentionsField(expression: QueryExpr, field: string): boolean {
  if ("field" in expression) return expression.field === field;
  if (expression.op === "not") return queryMentionsField(expression.operand, field);
  return expression.operands.some((operand) => queryMentionsField(operand, field));
}

function normalizeListOrderBy(
  orderBy: StorageOrderBy | undefined,
  index: CompiledIndex,
): OrderExpr {
  if (orderBy === undefined) {
    return { field: index.fields[0]!, direction: "asc" };
  }
  try {
    const normalized = normalizeOrderBy(orderBy);
    if (!index.fields.includes(normalized.field)) {
      throw new BadRequestError(`Order field is not part of index ${index.name}`);
    }
    return normalized;
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError(error instanceof Error ? error.message : "Invalid orderBy");
  }
}

function assertIndexFields(collection: string, name: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidCollection(collection, `index ${name} must be a non-empty tuple`);
  }
  const seen = new Set<string>();
  for (const field of value) {
    if (typeof field !== "string" || field.length === 0) {
      throw invalidCollection(collection, `index ${name} fields must be strings`);
    }
    if (field === TAKIBI_VERSION_KEY || field === TAKIBI_REVISION_KEY) {
      throw invalidCollection(collection, `index ${name} cannot use reserved field ${field}`);
    }
    if (
      (RESERVED_DOCUMENT_DATA_KEYS as readonly string[]).includes(field) &&
      !METADATA_FIELDS.has(field)
    ) {
      throw invalidCollection(collection, `index ${name} cannot use reserved field ${field}`);
    }
    if (seen.has(field)) {
      throw invalidCollection(collection, `index ${name} repeats field ${field}`);
    }
    seen.add(field);
  }
}

function isIndexScalar(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidCollection(collection: string, message: string): TakibiError {
  return new TakibiError("INVALID_COLLECTION", `${collection}: ${message}`, 500);
}
