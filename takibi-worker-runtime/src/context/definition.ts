import {
  ActionRegistry,
  TakibiError,
  assertCollectionName,
  assertNoActionsOption,
  createDocumentActionBuilder,
  createRootActionBuilder,
  defineCollection,
  type ActionDefinitions,
  type CollectionsDef,
} from "@takibi/takibi-api";
import { createPolicyHelper } from "@takibi/takibi-policy";
import { assertCollectionIndexes } from "@takibi/takibi-storage";
import { assertCollectionMigrations } from "../migrations";
import { assertCollectionUniqueConstraints } from "../unique";
import { Application } from "./application";
import { stubBackend } from "./backend";
import { ownStringEntries } from "./own-entries";
import { mergeLoggingOptions } from "./runtime";
import type { ActionScopeMap, ContextConfig, InternalCollectionsOptions } from "./types";

function validateCollections(collections: CollectionsDef<object>): void {
  for (const [name, definition] of ownStringEntries(collections, "INVALID_COLLECTION", {
    subject: "Collections",
    keys: "Collection names",
  })) {
    assertCollectionName(name);
    assertNoActionsOption(definition);
    assertCollectionMigrations(definition, name);
    assertCollectionUniqueConstraints(definition, name);
    assertCollectionIndexes(definition, name);
  }
}

function registerActions(map: ActionScopeMap, collections: ReadonlySet<string>): ActionRegistry {
  const registry = new ActionRegistry();
  for (const [scope, definitions] of ownStringEntries(map, "INVALID_ACTION", {
    subject: "Action scope map",
    keys: "Action scopes",
  })) {
    if (scope === "$") registry.registerRootActions(definitions, collections);
    else if (collections.has(scope)) registry.registerCollectionActions(scope, definitions);
    else throw new TakibiError("INVALID_ACTION", `Unknown action scope: ${scope}`, 500);
  }
  return registry;
}

/** Runtime implementation of the typed, dynamically keyed definition API. */
export function createContext(config: ContextConfig<object, unknown, unknown, unknown>) {
  const { resolve, services, stub } = config;
  const defaults = mergeLoggingOptions({}, config);
  return {
    policy: createPolicyHelper(),
    defineCollection,
    defineCollections(
      collections: CollectionsDef<object>,
      options: InternalCollectionsOptions = {},
    ) {
      validateCollections(collections);
      const names = new Set(Object.keys(collections));
      const settings = { ...defaults, ...options };
      const scoped: Record<string, unknown> = {};
      Object.setPrototypeOf(scoped, null);
      for (const name of names) {
        scoped[name] = {
          actions: (
            define: (
              builder: () => ReturnType<typeof createDocumentActionBuilder>,
            ) => ActionDefinitions,
          ) => define(() => createDocumentActionBuilder(name)),
        };
      }
      // Collection names were checked against these API members before merging.
      return Object.assign(scoped, {
        defineAction: createRootActionBuilder,
        actions(map: ActionScopeMap) {
          const application = new Application(
            { collections, actions: map, registry: registerActions(map, names) },
            {
              resolve,
              services,
              options: settings,
            },
          );
          return application.mount(stubBackend(stub));
        },
      });
    },
  };
}
