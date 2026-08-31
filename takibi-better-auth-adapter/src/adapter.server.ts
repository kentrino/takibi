import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { QueryExpr } from "@takibi/takibi";
import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type CleanedWhere,
  type CustomAdapter,
  type DBAdapter,
  type DBTransactionAdapter,
  type JoinConfig,
} from "better-auth/adapters";
import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db";

type Document = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type Collection = {
  add(
    data: Record<string, unknown>,
    options?: { id?: string; createdAt?: string; updatedAt?: string },
  ): Promise<Document>;
  update(id: string, data: Record<string, unknown>): Promise<Document>;
  delete(id: string): Promise<{ id: string }>;
  list(options?: {
    index?: string;
    limit?: number;
    where?: (query: RuntimeQueryBuilder) => QueryExpr;
  }): Promise<{ items: Document[]; nextCursor?: string }>;
  listAll(options?: {
    index?: string;
    maxItems?: number;
    where?: (query: RuntimeQueryBuilder) => QueryExpr;
  }): Promise<Document[]>;
  count(options?: {
    index?: string;
    where?: (query: RuntimeQueryBuilder) => QueryExpr;
  }): Promise<number>;
  updateMany(
    data: Record<string, unknown>,
    options: {
      index?: string;
      where: (query: RuntimeQueryBuilder) => QueryExpr;
    },
  ): Promise<{ updated: number }>;
  deleteMany(options: {
    index?: string;
    where: (query: RuntimeQueryBuilder) => QueryExpr;
  }): Promise<{ deleted: number }>;
  consumeOne(options: {
    index?: string;
    where: (query: RuntimeQueryBuilder) => QueryExpr;
  }): Promise<Document | null>;
  incrementOne(
    increment: Record<string, number>,
    options: {
      index?: string;
      where: (query: RuntimeQueryBuilder) => QueryExpr;
      set?: Record<string, unknown>;
    },
  ): Promise<Document | null>;
};

type RuntimeCollections = Record<string, Collection>;

type RuntimeQueryField = {
  present(): QueryExpr;
  eq(value: string | number | boolean | null): QueryExpr;
  in(values: readonly (string | number | boolean | null)[]): QueryExpr;
  gt(value: string | number): QueryExpr;
  gte(value: string | number): QueryExpr;
  lt(value: string | number): QueryExpr;
  lte(value: string | number): QueryExpr;
  contains(value: string): QueryExpr;
  startsWith(value: string): QueryExpr;
  endsWith(value: string): QueryExpr;
};

type RuntimeQueryBuilder = Record<string, RuntimeQueryField> & {
  and(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  or(first: QueryExpr, second: QueryExpr, ...rest: QueryExpr[]): QueryExpr;
  not(operand: QueryExpr): QueryExpr;
};

export type BetterAuthModelBinding<TCollectionName extends string = string> = {
  collection: TCollectionName;
  schema: StandardSchemaV1;
  indexes?: Readonly<Record<string, readonly string[]>>;
  /**
   * Storage-form values used only by compatibility validation when a field
   * has a semantic refinement (for example, a UUID).
   */
  schemaSamples?: Readonly<Record<string, unknown>>;
};

export type BetterAuthModelMap<TCollectionName extends string = string> = {
  user: BetterAuthModelBinding<TCollectionName>;
  session: BetterAuthModelBinding<TCollectionName>;
  account: BetterAuthModelBinding<TCollectionName>;
  verification: BetterAuthModelBinding<TCollectionName>;
} & Record<string, BetterAuthModelBinding<TCollectionName>>;

export type TakibiFallbackScanEvent = {
  model: string;
  operation: AdapterMethod;
  operators: string[];
  scannedCount: number;
};

export type TakibiAdapterOptions<TCollections> = {
  /**
   * A generated Durable Object's trusted `$collections` facade.
   * Never pass a public or policy-bound Takibi client here.
   */
  collections: TCollections;
  /**
   * Bind a callback to the generated Durable Object's trusted collections
   * `$transaction`.
   */
  transaction<R>(callback: (collections: TCollections) => Promise<R>): Promise<R>;
  /**
   * Better Auth default model name to Takibi collection name.
   * Plugin models must be mapped explicitly.
   */
  models: BetterAuthModelMap<Extract<keyof TCollections, string>>;
  /**
   * Maximum documents a fallback scan may inspect for one collection.
   * @default 10000
   */
  maxScanItems?: number;
  /**
   * Receives metadata-only fallback scan events. Field values and documents
   * are never included.
   */
  onFallbackScan?(event: TakibiFallbackScanEvent): void;
};

type RunTransaction = <R>(callback: (collections: RuntimeCollections) => Promise<R>) => Promise<R>;

export type AdapterMethod =
  | "count"
  | "delete"
  | "deleteMany"
  | "findMany"
  | "findOne"
  | "incrementOne"
  | "update"
  | "updateMany"
  | "consumeOne";

const RESERVED_WRITE_FIELDS = new Set(["id", "createdAt", "updatedAt", "rev", "$schemaVersion"]);

/**
 * Build a Better Auth database adapter over trusted Takibi collections.
 *
 * This initial adapter keeps Better Auth-only compatibility operations
 * (arbitrary sort, offset, projection-compatible reads, and joins) inside the
 * adapter. Every scan is bounded and observable through a metadata-only hook.
 * Race-sensitive writes are executed inside the supplied Takibi transaction.
 */
export function takibiAdapter<TCollections>(
  adapterOptions: TakibiAdapterOptions<TCollections>,
): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
  const rootCollections = adapterOptions.collections as RuntimeCollections;
  const maxScanItems = adapterOptions.maxScanItems ?? 10_000;
  assertMaxScanItems(maxScanItems);

  const rootTransaction: RunTransaction = (callback) =>
    adapterOptions.transaction((collections) => callback(collections as RuntimeCollections));

  const createFactory = (
    activeCollections: RuntimeCollections,
    runTransaction: RunTransaction,
    activeOptions: BetterAuthOptions,
  ) =>
    createAdapterFactory({
      config: {
        adapterId: "takibi",
        adapterName: "Takibi Adapter",
        supportsNumericIds: false,
        supportsUUIDs: false,
        supportsJSON: true,
        supportsDates: false,
        supportsBooleans: true,
        supportsArrays: true,
        transaction: async <R>(
          callback: (adapter: DBTransactionAdapter) => Promise<R>,
        ): Promise<R> =>
          runTransaction(async (transactionCollections) => {
            const transactionAdapter = createFactory(
              transactionCollections,
              async (nested) => nested(transactionCollections),
              activeOptions,
            )(activeOptions);
            return callback(transactionAdapter);
          }),
      },
      adapter: ({ getDefaultModelName, schema }): CustomAdapter => {
        let schemaCompatibility: Promise<void> | undefined;
        const assertSchemaCompatibility = () =>
          (schemaCompatibility ??= validateModelSchemas(schema, adapterOptions.models));

        const bindingFor = (model: string): BetterAuthModelBinding => {
          const defaultModel = getDefaultModelName(model);
          const binding = adapterOptions.models[defaultModel] ?? adapterOptions.models[model];
          if (!binding) {
            throw new Error(`Better Auth model "${defaultModel}" has no Takibi collection mapping`);
          }
          return binding;
        };

        const collectionFor = (collections: RuntimeCollections, model: string): Collection => {
          const binding = bindingFor(model);
          const collection = collections[binding.collection];
          if (!collection) {
            throw new Error(`Mapped Takibi collection "${binding.collection}" is not available`);
          }
          return collection;
        };

        const readDocuments = async (
          collections: RuntimeCollections,
          model: string,
          where: CleanedWhere[] | undefined,
          method: AdapterMethod,
          options: { limit?: number; forceFallback?: boolean } = {},
        ): Promise<Document[]> => {
          await assertSchemaCompatibility();
          const pushedWhere = compileTakibiWhere(where);
          const binding = bindingFor(model);
          const index = selectTakibiIndex(binding.indexes, where);
          const collection = collectionFor(collections, model);
          const requiresResidual = Boolean(where?.length) && pushedWhere === undefined;
          if (requiresResidual || options.forceFallback) {
            const documents = await collection.listAll({
              maxItems: maxScanItems,
              ...(pushedWhere ? { where: pushedWhere } : {}),
              ...(index ? { index } : {}),
            });
            adapterOptions.onFallbackScan?.({
              model: getDefaultModelName(model),
              operation: method,
              operators: [...new Set((where ?? []).map(({ operator }) => operator))],
              scannedCount: documents.length,
            });
            return documents.filter((document) => matchesWhere(document, where));
          }

          const page = await collection.list({
            ...(pushedWhere ? { where: pushedWhere } : {}),
            ...(index ? { index } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          });
          return page.items;
        };

        const conditionalSelector = (
          model: string,
          where: CleanedWhere[],
        ):
          | {
              where: (query: RuntimeQueryBuilder) => QueryExpr;
              index?: string;
            }
          | undefined => {
          if (where.length === 0) return undefined;
          const pushedWhere = compileTakibiWhere(where);
          if (!pushedWhere) return undefined;
          const index = selectTakibiIndex(bindingFor(model).indexes, where);
          return { where: pushedWhere, ...(index ? { index } : {}) };
        };

        const fallbackUpdateOne = async (
          collections: RuntimeCollections,
          model: string,
          where: CleanedWhere[],
          update: Record<string, unknown>,
        ): Promise<Document | null> => {
          const target = (
            await readDocuments(collections, model, where, "update", { forceFallback: true })
          )[0];
          if (!target) return null;
          return collectionFor(collections, model).update(target.id, writeData(update));
        };

        const fallbackUpdateMany = async (
          collections: RuntimeCollections,
          model: string,
          where: CleanedWhere[],
          update: Record<string, unknown>,
        ): Promise<number> => {
          const targets = await readDocuments(collections, model, where, "updateMany", {
            forceFallback: true,
          });
          for (const target of targets) {
            await collectionFor(collections, model).update(target.id, writeData(update));
          }
          return targets.length;
        };

        const fallbackDeleteMany = async (
          collections: RuntimeCollections,
          model: string,
          where: CleanedWhere[],
          method: "delete" | "deleteMany" | "consumeOne",
          limit?: number,
        ): Promise<Document[]> => {
          const targets = (
            await readDocuments(collections, model, where, method, { forceFallback: true })
          ).slice(0, limit);
          for (const target of targets) {
            await collectionFor(collections, model).delete(target.id);
          }
          return targets;
        };

        return {
          async create({ model, data }) {
            await assertSchemaCompatibility();
            const id = data.id;
            if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
              throw new TypeError("Better Auth id must be a non-empty string when provided");
            }
            const createdAt = typeof data.createdAt === "string" ? data.createdAt : undefined;
            const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : undefined;
            return collectionFor(activeCollections, model).add(writeData(data), {
              ...(id === undefined ? {} : { id }),
              ...(createdAt === undefined ? {} : { createdAt }),
              ...(updatedAt === undefined ? {} : { updatedAt }),
            }) as Promise<typeof data>;
          },

          async findOne({ model, where, join }) {
            const document = (
              await readDocuments(activeCollections, model, where, "findOne", {
                limit: 1,
              })
            )[0];
            if (!document) return null;
            return applyJoins(
              document,
              join,
              activeCollections,
              collectionFor,
              readDocuments,
            ) as Promise<never>;
          },

          async findMany({ model, where, limit, sortBy, offset, join, select }) {
            const forceFallback = sortBy !== undefined || offset !== undefined;
            let documents = await readDocuments(activeCollections, model, where, "findMany", {
              limit,
              forceFallback,
            });
            if (sortBy) {
              documents = [...documents].sort((left, right) =>
                compareValues(left[sortBy.field], right[sortBy.field], sortBy.direction),
              );
            }
            const start = offset ?? 0;
            const page = documents.slice(start, start + limit);
            return Promise.all(
              page.map(async (document) =>
                projectDocument(
                  await applyJoins(document, join, activeCollections, collectionFor, readDocuments),
                  select,
                  join,
                ),
              ),
            ) as Promise<never[]>;
          },

          async count({ model, where }) {
            await assertSchemaCompatibility();
            const pushedWhere = compileTakibiWhere(where);
            if (where?.length && !pushedWhere) {
              return (await readDocuments(activeCollections, model, where, "count")).length;
            }
            const binding = bindingFor(model);
            const index = selectTakibiIndex(binding.indexes, where);
            return collectionFor(activeCollections, model).count({
              ...(pushedWhere ? { where: pushedWhere } : {}),
              ...(index ? { index } : {}),
            });
          },

          update: ({ model, where, update }) =>
            runTransaction(async (collections) => {
              await assertSchemaCompatibility();
              if (where.length === 0) return null;
              const selector = conditionalSelector(model, where);
              if (!selector) {
                return fallbackUpdateOne(
                  collections,
                  model,
                  where,
                  update as Record<string, unknown>,
                );
              }
              const target = (
                await collectionFor(collections, model).list({ ...selector, limit: 1 })
              ).items[0];
              if (!target) return null;
              return collectionFor(collections, model).update(
                target.id,
                writeData(update as Record<string, unknown>),
              );
            }) as Promise<never>,

          updateMany: ({ model, where, update }) =>
            runTransaction(async (collections) => {
              await assertSchemaCompatibility();
              const selector = conditionalSelector(model, where);
              if (!selector) {
                return fallbackUpdateMany(collections, model, where, update);
              }
              return (
                await collectionFor(collections, model).updateMany(writeData(update), selector)
              ).updated;
            }),

          async delete({ model, where }) {
            if (where.length === 0) return;
            await runTransaction(async (collections) => {
              await assertSchemaCompatibility();
              const selector = conditionalSelector(model, where);
              if (!selector) {
                await fallbackDeleteMany(collections, model, where, "delete", 1);
                return;
              }
              await collectionFor(collections, model).consumeOne(selector);
            });
          },

          deleteMany: ({ model, where }) =>
            runTransaction(async (collections) => {
              await assertSchemaCompatibility();
              const selector = conditionalSelector(model, where);
              if (!selector) {
                return fallbackDeleteMany(collections, model, where, "deleteMany").then(
                  (documents) => documents.length,
                );
              }
              return (await collectionFor(collections, model).deleteMany(selector)).deleted;
            }),

          consumeOne: ({ model, where }) =>
            runTransaction(async (collections) => {
              await assertSchemaCompatibility();
              const selector = conditionalSelector(model, where);
              if (!selector) {
                const consumed = await fallbackDeleteMany(
                  collections,
                  model,
                  where,
                  "consumeOne",
                  1,
                );
                return consumed[0] ?? null;
              }
              return collectionFor(collections, model).consumeOne(selector);
            }) as Promise<never>,

          incrementOne: ({ model, where, increment, set }) =>
            runTransaction(async (collections) => {
              await assertSchemaCompatibility();
              const selector = conditionalSelector(model, where);
              if (selector) {
                return collectionFor(collections, model).incrementOne(increment, {
                  ...selector,
                  ...(set === undefined ? {} : { set: writeData(set) }),
                });
              }
              const target = (
                await readDocuments(collections, model, where, "incrementOne", {
                  forceFallback: true,
                })
              )[0];
              if (!target) return null;
              const update: Record<string, unknown> = { ...set };
              for (const [field, delta] of Object.entries(increment)) {
                const current = target[field];
                update[field] = (typeof current === "number" ? current : 0) + delta;
              }
              return collectionFor(collections, model).update(target.id, writeData(update));
            }) as Promise<never>,
        };
      },
    });

  return (options) => createFactory(rootCollections, rootTransaction, options)(options);
}

async function applyJoins(
  document: Document,
  join: JoinConfig | undefined,
  collections: RuntimeCollections,
  collectionFor: (collections: RuntimeCollections, model: string) => Collection,
  readDocuments: (
    collections: RuntimeCollections,
    model: string,
    where: CleanedWhere[] | undefined,
    method: AdapterMethod,
    options?: { limit?: number; forceFallback?: boolean },
  ) => Promise<Document[]>,
): Promise<Document> {
  if (!join) return document;
  const output: Document = { ...document };
  for (const [model, config] of Object.entries(join)) {
    collectionFor(collections, model);
    const related = await readDocuments(
      collections,
      model,
      [
        {
          field: config.on.to,
          value: document[config.on.from] as string | number | boolean | null,
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
      "findMany",
      { forceFallback: true },
    );
    output[model] =
      config.relation === "one-to-one" ? (related[0] ?? null) : related.slice(0, config.limit);
  }
  return output;
}

function projectDocument(
  document: Document,
  select: string[] | undefined,
  join: JoinConfig | undefined,
): Record<string, unknown> {
  if (!select?.length) return document;
  const retained = new Set([...select, ...Object.keys(join ?? {})]);
  return Object.fromEntries(Object.entries(document).filter(([field]) => retained.has(field)));
}

function writeData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([field, value]) => !RESERVED_WRITE_FIELDS.has(field) && value !== undefined,
    ),
  );
}

function selectTakibiIndex(
  indexes: Readonly<Record<string, readonly string[]>> | undefined,
  where: CleanedWhere[] | undefined,
): string | undefined {
  if (!indexes || !where) return undefined;
  const equalityFields = new Set(
    where
      .filter(
        (clause) =>
          clause.operator === "eq" &&
          clause.mode === "sensitive" &&
          clause.value !== null &&
          isTakibiScalar(toTakibiScalar(clause.value)),
      )
      .map(({ field }) => field),
  );
  return Object.entries(indexes)
    .filter(([, fields]) => fields[0] && equalityFields.has(fields[0]))
    .sort((left, right) => right[1].length - left[1].length)[0]?.[0];
}

function compileTakibiWhere(
  where: CleanedWhere[] | undefined,
): ((query: RuntimeQueryBuilder) => QueryExpr) | undefined {
  if (
    !where ||
    where.length === 0 ||
    !where.every(canPushClause) ||
    estimateQueryShape(where).nodes > 32 ||
    estimateQueryShape(where).depth > 8
  ) {
    return undefined;
  }
  return (query) => {
    const expressions = where.map((clause) => compileTakibiClause(query, clause));
    let expression = expressions[0]!;
    for (let index = 1; index < expressions.length; index += 1) {
      expression =
        where[index]!.connector === "OR"
          ? query.or(expression, expressions[index]!)
          : query.and(expression, expressions[index]!);
    }
    return expression;
  };
}

function estimateQueryShape(where: CleanedWhere[]): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  for (const clause of where) {
    const leaf =
      clause.operator === "eq" && clause.value === null
        ? { nodes: 4, depth: 3 }
        : clause.operator === "ne" && clause.value === null
          ? { nodes: 5, depth: 4 }
          : clause.operator === "ne" || clause.operator === "not_in"
            ? { nodes: 2, depth: 2 }
            : { nodes: 1, depth: 1 };
    nodes += leaf.nodes + (depth === 0 ? 0 : 1);
    depth = depth === 0 ? leaf.depth : Math.max(depth, leaf.depth) + 1;
  }
  return { nodes, depth };
}

function canPushClause(clause: CleanedWhere): boolean {
  if (clause.mode === "insensitive") return false;
  if (clause.operator === "in" || clause.operator === "not_in") {
    return (
      Array.isArray(clause.value) &&
      clause.value.length > 0 &&
      clause.value.length <= 32 &&
      clause.value.every((value) => isTakibiScalar(toTakibiScalar(value)))
    );
  }
  const value = toTakibiScalar(clause.value);
  switch (clause.operator) {
    case "eq":
    case "ne":
      return isTakibiScalar(value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return typeof value === "string" || typeof value === "number";
    case "contains":
    case "starts_with":
    case "ends_with":
      return typeof value === "string";
    default:
      return false;
  }
}

function compileTakibiClause(query: RuntimeQueryBuilder, clause: CleanedWhere): QueryExpr {
  const field = query[clause.field]!;
  const value = toTakibiScalar(clause.value);
  if (clause.operator === "in" || clause.operator === "not_in") {
    const values = (clause.value as unknown[]).map(toTakibiScalar) as Array<
      string | number | boolean | null
    >;
    const expression = field.in(values);
    return clause.operator === "not_in" ? query.not(expression) : expression;
  }
  if (clause.operator === "eq" || clause.operator === "ne") {
    const equality =
      value === null
        ? query.or(field.eq(null), query.not(field.present()))
        : field.eq(value as string | number | boolean);
    return clause.operator === "ne" ? query.not(equality) : equality;
  }
  const comparable = value as string | number;
  switch (clause.operator) {
    case "gt":
      return field.gt(comparable);
    case "gte":
      return field.gte(comparable);
    case "lt":
      return field.lt(comparable);
    case "lte":
      return field.lte(comparable);
    case "contains":
      return field.contains(comparable as string);
    case "starts_with":
      return field.startsWith(comparable as string);
    case "ends_with":
      return field.endsWith(comparable as string);
    default:
      throw new TypeError("Unsupported Takibi query operator");
  }
}

function toTakibiScalar(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function isTakibiScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function matchesWhere(
  document: Readonly<Record<string, unknown>>,
  where: CleanedWhere[] | undefined,
): boolean {
  if (!where || where.length === 0) return true;
  let result = matchesClause(document, where[0]!);
  for (let index = 1; index < where.length; index += 1) {
    const clause = where[index]!;
    const matches = matchesClause(document, clause);
    result = clause.connector === "OR" ? result || matches : result && matches;
  }
  return result;
}

function matchesClause(document: Readonly<Record<string, unknown>>, clause: CleanedWhere): boolean {
  const actual = document[clause.field];
  const expected = Array.isArray(clause.value)
    ? clause.value.map(toTakibiScalar)
    : toTakibiScalar(clause.value);
  const insensitive =
    clause.mode === "insensitive" &&
    (typeof expected === "string" ||
      (Array.isArray(expected) && expected.every((value) => typeof value === "string")));
  const equal = (left: unknown, right: unknown) =>
    right === null
      ? left === null || left === undefined
      : insensitive && typeof left === "string" && typeof right === "string"
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;

  switch (clause.operator) {
    case "eq":
      return expected === null ? actual == null : equal(actual, expected);
    case "ne":
      return !equal(actual, expected);
    case "in":
      return Array.isArray(expected) && expected.some((value) => equal(actual, value));
    case "not_in":
      return Array.isArray(expected) && !expected.some((value) => equal(actual, value));
    case "contains":
      return stringMatch(actual, expected, insensitive, (value, search) => value.includes(search));
    case "starts_with":
      return stringMatch(actual, expected, insensitive, (value, search) =>
        value.startsWith(search),
      );
    case "ends_with":
      return stringMatch(actual, expected, insensitive, (value, search) => value.endsWith(search));
    case "gt":
      return compareComparable(actual, expected) > 0;
    case "gte":
      return compareComparable(actual, expected) >= 0;
    case "lt":
      return compareComparable(actual, expected) < 0;
    case "lte":
      return compareComparable(actual, expected) <= 0;
  }
}

function stringMatch(
  actual: unknown,
  expected: unknown,
  insensitive: boolean,
  compare: (actual: string, expected: string) => boolean,
): boolean {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  return insensitive
    ? compare(actual.toLowerCase(), expected.toLowerCase())
    : compare(actual, expected);
}

function compareComparable(actual: unknown, expected: unknown): number {
  if (
    (typeof actual !== "string" && typeof actual !== "number") ||
    typeof actual !== typeof expected
  ) {
    return Number.NaN;
  }
  if (actual === expected) return 0;
  if (typeof actual === "string" && typeof expected === "string") {
    return actual > expected ? 1 : -1;
  }
  if (typeof actual === "number" && typeof expected === "number") {
    return actual > expected ? 1 : -1;
  }
  return Number.NaN;
}

function compareValues(left: unknown, right: unknown, direction: "asc" | "desc"): number {
  let result: number;
  if (left == null && right == null) result = 0;
  else if (left == null) result = -1;
  else if (right == null) result = 1;
  else if (typeof left === "string" && typeof right === "string") {
    result = left.localeCompare(right);
  } else if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else if (typeof left === "boolean" && typeof right === "boolean") {
    result = left === right ? 0 : left ? 1 : -1;
  } else {
    result = 0;
  }
  return direction === "asc" ? result : -result;
}

function assertMaxScanItems(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("maxScanItems must be a positive integer");
  }
}

async function validateModelSchemas(
  betterAuthSchema: BetterAuthDBSchema,
  mappings: Record<string, BetterAuthModelBinding>,
): Promise<void> {
  for (const [model, definition] of Object.entries(betterAuthSchema)) {
    const binding = mappings[model];
    if (!binding) {
      throw new TypeError(`Better Auth model "${model}" has no Takibi collection mapping`);
    }

    const probe: Record<string, unknown> = {};
    const attributesByField = new Map<string, DBFieldAttribute>();
    for (const [field, attributes] of Object.entries(definition.fields)) {
      const storageField = attributes.fieldName ?? field;
      if (storageField !== field) {
        throw new TypeError(
          `Better Auth fieldName mapping is not supported by Takibi schema validation: ${model}.${field}`,
        );
      }
      if (RESERVED_WRITE_FIELDS.has(field)) continue;
      probe[field] = await sampleFieldValue(field, attributes, binding.schemaSamples?.[field]);
      attributesByField.set(field, attributes);
    }

    const value = await validateSchemaProbe(binding.schema, model, probe);
    const requiredOnly = await validateSchemaProbe(
      binding.schema,
      model,
      Object.fromEntries(
        Object.entries(probe).filter(([field]) => attributesByField.get(field)?.required !== false),
      ),
      "all optional fields",
    );
    assertProbeFieldTypes(model, requiredOnly, attributesByField);

    for (const [field, attributes] of attributesByField) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        throw new TypeError(
          `Takibi schema for Better Auth model "${model}" does not retain field "${field}"`,
        );
      }
      if (!matchesStoredFieldType(value[field], attributes)) {
        throw new TypeError(
          `Takibi schema for Better Auth model "${model}" changes the storage type of field "${field}"`,
        );
      }
      if (attributes.required === false) {
        const omitted = { ...probe };
        delete omitted[field];
        const omittedValue = await validateSchemaProbe(binding.schema, model, omitted, field);
        assertProbeFieldTypes(model, omittedValue, attributesByField);

        const nullable = await validateSchemaProbe(
          binding.schema,
          model,
          { ...probe, [field]: null },
          field,
        );
        if (nullable[field] !== null) {
          throw new TypeError(
            `Takibi schema for Better Auth model "${model}" changes null field "${field}"`,
          );
        }
      }
    }
  }
}

async function validateSchemaProbe(
  schema: StandardSchemaV1,
  model: string,
  probe: Record<string, unknown>,
  optionalField?: string,
): Promise<Record<string, unknown>> {
  const result = await schema["~standard"].validate(probe);
  if (result.issues) {
    const paths = result.issues
      .flatMap((issue) =>
        issue.path ? [issue.path.map((segment) => formatPathSegment(segment)).join(".")] : [],
      )
      .filter((path) => path.length > 0);
    throw new TypeError(
      `Takibi schema for Better Auth model "${model}" rejected its ${
        optionalField ? `optional/null field "${optionalField}"` : "field contract"
      }${paths.length > 0 ? ` (${[...new Set(paths)].join(", ")})` : ""}`,
    );
  }
  if (!isRecord(result.value)) {
    throw new TypeError(`Takibi schema for Better Auth model "${model}" must produce an object`);
  }
  return result.value;
}

async function sampleFieldValue(
  field: string,
  attributes: DBFieldAttribute,
  configured: unknown,
): Promise<unknown> {
  if (configured !== undefined) return configured;
  if (attributes.defaultValue !== undefined && typeof attributes.defaultValue !== "function") {
    return attributes.defaultValue instanceof Date
      ? attributes.defaultValue.toISOString()
      : attributes.defaultValue;
  }
  if (Array.isArray(attributes.type)) return attributes.type[0];
  switch (attributes.type) {
    case "string":
      if (field.toLowerCase().includes("email")) {
        return "adapter-check@example.com";
      }
      if (field.toLowerCase().includes("image")) {
        return "https://example.com/image.png";
      }
      if (field.toLowerCase().includes("ip")) return "127.0.0.1";
      if (field === "role") return "user";
      return `adapter-check-${field}`;
    case "number":
      return 1;
    case "boolean":
      return false;
    case "date":
      return "2026-01-01T00:00:00.000Z";
    case "json":
      return {};
    case "string[]":
    case "number[]":
      return [];
  }
}

function matchesStoredFieldType(value: unknown, attributes: DBFieldAttribute): boolean {
  if (value === null) return attributes.required === false;
  if (Array.isArray(attributes.type)) {
    return typeof value === "string" && attributes.type.includes(value);
  }
  switch (attributes.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "json":
      return isJsonValue(value);
    case "string[]":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    case "number[]":
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      );
  }
}

function assertProbeFieldTypes(
  model: string,
  value: Record<string, unknown>,
  attributesByField: ReadonlyMap<string, DBFieldAttribute>,
): void {
  for (const [field, attributes] of attributesByField) {
    if (
      Object.prototype.hasOwnProperty.call(value, field) &&
      !matchesStoredFieldType(value[field], attributes)
    ) {
      throw new TypeError(
        `Takibi schema for Better Auth model "${model}" changes the storage type of field "${field}"`,
      );
    }
  }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPathSegment(segment: unknown): string {
  if (typeof segment === "string" || typeof segment === "number") {
    return String(segment);
  }
  if (typeof segment === "symbol") return segment.description ?? "symbol";
  if (isRecord(segment) && "key" in segment) {
    return formatPathSegment(segment.key);
  }
  return "field";
}
