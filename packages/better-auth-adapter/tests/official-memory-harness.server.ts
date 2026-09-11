import type { BetterAuthOptions } from "better-auth";
import { getAuthTables, type DBFieldAttribute } from "better-auth/db";
import { z } from "zod";
import { takibiAdapter, type BetterAuthModelMap } from "../src/adapter.server.ts";
import { createTestCollection } from "./test-collection.server";

type Row = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type State = {
  tables: Record<string, Map<string, Row>>;
};

type HarnessCollection = ReturnType<typeof createTestCollection>;
type HarnessTransaction = <R>(
  callback: (collections: HarnessCollections) => Promise<R>,
) => Promise<R>;
type HarnessCollections = {
  [name: string]: HarnessCollection | HarnessTransaction;
  $transaction: HarnessTransaction;
};

export function createOfficialMemoryHarness() {
  const state: State = { tables: {} };

  const collectionsFor = (
    active: State,
    models: readonly string[],
    transactionBound = false,
  ): HarnessCollections => {
    const collections: HarnessCollections = {
      ...Object.fromEntries(
        models.map((name) => {
          const table = () => (active.tables[name] ??= new Map());
          return [name, createTestCollection(table)];
        }),
      ),
      async $transaction<R>(callback: (scoped: HarnessCollections) => Promise<R>): Promise<R> {
        if (transactionBound) return callback(collections);
        const snapshot: State = {
          tables: Object.fromEntries(
            Object.entries(active.tables).map(([name, table]) => [
              name,
              new Map([...table].map(([id, row]) => [id, structuredClone(row)])),
            ]),
          ),
        };
        const result = await callback(collectionsFor(snapshot, models, true));
        active.tables = snapshot.tables;
        return result;
      },
    };
    return collections;
  };

  const databaseFor = (options: BetterAuthOptions) => {
    const authTables = getAuthTables(options);
    const modelNames = Object.keys(authTables);
    const collections = collectionsFor(state, modelNames);
    const models = Object.fromEntries(
      Object.entries(authTables).map(([model, definition]) => [
        model,
        {
          collection: model,
          schema: schemaFor(definition.fields),
        },
      ]),
    ) as unknown as BetterAuthModelMap<string>;

    return takibiAdapter({
      collections,
      models,
    });
  };

  return { databaseFor };
}

function schemaFor(fields: Record<string, DBFieldAttribute>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [field, attributes] of Object.entries(fields)) {
    if (field === "id" || field === "createdAt" || field === "updatedAt") {
      continue;
    }
    let schema: z.ZodType = fieldSchema(attributes);
    if (attributes.required === false) {
      schema = schema.nullable().optional();
    }
    shape[field] = schema;
  }
  return z.object(shape);
}

function fieldSchema(attributes: DBFieldAttribute): z.ZodType {
  if (Array.isArray(attributes.type)) return z.enum(attributes.type);
  switch (attributes.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "date":
      return z.iso.datetime();
    case "json":
      return z.json();
    case "string[]":
      return z.array(z.string());
    case "number[]":
      return z.array(z.number());
  }
}
