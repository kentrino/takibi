import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { QueryExpr } from "takibi";
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
import {
  compareBetterAuthValues,
  compileTakibiWhere,
  matchesBetterAuthWhere,
  type RuntimeQueryBuilder,
  selectTakibiIndex,
} from "./query.server";

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

type RuntimeTransaction = <R>(
  callback: (collections: RuntimeCollections) => Promise<R>,
) => Promise<R>;

type RuntimeCollections = {
  $transaction: RuntimeTransaction;
} & { readonly [name: string]: Collection | RuntimeTransaction };

/**
 * Minimal transaction capability structurally compatible with Takibi's
 * `TrustedCollectionsApi`. Avoids a recursive `T extends T & { $transaction }`
 * constraint that collapses inference.
 */
export type TransactionalCollections<TCollections> = TCollections & {
  $transaction<R>(callback: (collections: TCollections) => Promise<R>): Promise<R>;
};

export type BetterAuthModelBinding<TCollectionName extends string = string> = {
  collection: TCollectionName extends "$transaction" ? never : TCollectionName;
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

type CollectionNameOf<TCollections> = Exclude<Extract<keyof TCollections, string>, "$transaction">;

export type TakibiAdapterOptions<TCollections> = {
  /**
   * A generated Durable Object's trusted `$collections` facade.
   * Never pass a public or policy-bound Takibi client here.
   */
  collections: TransactionalCollections<TCollections>;
  /**
   * Better Auth default model name to Takibi collection name.
   * Plugin models must be mapped explicitly.
   */
  models: BetterAuthModelMap<CollectionNameOf<TCollections>>;
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
 * Race-sensitive writes are executed inside the trusted collections `$transaction`.
 */
export function takibiAdapter<TCollections>(
  adapterOptions: TakibiAdapterOptions<TCollections>,
): (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions> {
  const rootCollections = adapterOptions.collections as RuntimeCollections;
  const maxScanItems = adapterOptions.maxScanItems ?? 10_000;
  assertMaxScanItems(maxScanItems);
  const schemaCompatibilityByOptions = new WeakMap<BetterAuthOptions, Promise<void>>();

  const createFactory = (activeCollections: RuntimeCollections, activeOptions: BetterAuthOptions) =>
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
          activeCollections.$transaction(async (transactionCollections) => {
            const transactionAdapter = createFactory(
              transactionCollections,
              activeOptions,
            )(activeOptions);
            return callback(transactionAdapter);
          }),
      },
      adapter: ({ getDefaultModelName, schema }): CustomAdapter => {
        const assertSchemaCompatibility = () => {
          const cached = schemaCompatibilityByOptions.get(activeOptions);
          if (cached) return cached;
          const validation = validateModelSchemas(schema, adapterOptions.models);
          schemaCompatibilityByOptions.set(activeOptions, validation);
          return validation;
        };

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
          if (!isRuntimeCollection(collection)) {
            throw new Error(`Mapped Takibi collection "${binding.collection}" is not available`);
          }
          return collection;
        };

        const readDocuments = async (
          collections: RuntimeCollections,
          model: string,
          where: CleanedWhere[] | undefined,
          method: AdapterMethod,
          options: { limit?: number; materializeAll?: boolean } = {},
        ): Promise<Document[]> => {
          await assertSchemaCompatibility();
          const pushedWhere = compileTakibiWhere(where);
          const binding = bindingFor(model);
          const index = selectTakibiIndex(binding.indexes, where);
          const collection = collectionFor(collections, model);
          const residualWhere = pushedWhere ? undefined : where;
          if (residualWhere?.length || options.materializeAll) {
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
            return residualWhere?.length
              ? documents.filter((document) => matchesBetterAuthWhere(document, residualWhere))
              : documents;
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
            await readDocuments(collections, model, where, "update", { materializeAll: true })
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
            materializeAll: true,
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
            await readDocuments(collections, model, where, method, { materializeAll: true })
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
            const materializeAll = sortBy !== undefined || offset !== undefined;
            let documents = await readDocuments(activeCollections, model, where, "findMany", {
              limit,
              materializeAll,
            });
            if (sortBy) {
              documents = [...documents].sort((left, right) =>
                compareBetterAuthValues(left[sortBy.field], right[sortBy.field], sortBy.direction),
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
            activeCollections.$transaction(async (collections) => {
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
            activeCollections.$transaction(async (collections) => {
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
            await activeCollections.$transaction(async (collections) => {
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
            activeCollections.$transaction(async (collections) => {
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
            activeCollections.$transaction(async (collections) => {
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
            activeCollections.$transaction(async (collections) => {
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
                  materializeAll: true,
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

  return (options) => createFactory(rootCollections, options)(options);
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
    options?: { limit?: number; materializeAll?: boolean },
  ) => Promise<Document[]>,
): Promise<Document> {
  if (!join) return document;
  const output: Document = { ...document };
  for (const [model, config] of Object.entries(join)) {
    collectionFor(collections, model);
    const limit = config.relation === "one-to-one" ? 1 : config.limit;
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
      limit === undefined ? { materializeAll: true } : { limit },
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

function isRuntimeCollection(
  value: Collection | RuntimeTransaction | undefined,
): value is Collection {
  return typeof value === "object" && value !== null;
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
