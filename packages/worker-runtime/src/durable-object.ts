import {
  ForbiddenError,
  type ActionRegistry,
  type CollectionDefinition,
  type CollectionsDef,
  type DurableObjectCollectionsApi,
} from "@takibi/api";
import { applyStorageLogging, errorResponse } from "./context/runtime";
import type { InternalCollectionsOptions } from "./context/types";
import { createTrustedCollections } from "./executor";
import type { PublicRequest } from "./http";
import { resolveLocalExecution } from "./invocation-execution";
import type { InternalLogger } from "./logging";
import {
  createMaintenanceGatedCollections,
  initializeMaintenanceLayout,
  MaintenanceController,
} from "@takibi/snapshot";
import {
  compileIndexRegistry,
  createDurableObjectStorage,
  reconcileCollectionIndexes,
  type StorageDriver,
} from "@takibi/storage";
import { createMigratingStorage } from "./migrations";
import { parseWireRequest } from "./protocol";
import { createDurableObjectCollectionsApi } from "./snapshot";
import { bindTracer, extractTraceContext, resolveTracer, tracedStorage } from "./tracing";
import { storageAdd } from "./typed-storage";

type DurableObjectClass<TCollections, TEnv> = new (
  state: DurableObjectState,
  env: TEnv,
) => DurableObject & {
  $collections: DurableObjectCollectionsApi<TCollections>;
};

export function createDurableObjectClass<
  TCollections extends CollectionsDef,
  TEnv = unknown,
  TServices = unknown,
>(
  collections: TCollections,
  registry: ActionRegistry,
  options: InternalCollectionsOptions,
  logger: InternalLogger | undefined,
  createServices?: (input: { env: TEnv }) => TServices,
): DurableObjectClass<TCollections, TEnv> {
  return class TakibiTenantObject implements DurableObject {
    readonly #state: DurableObjectState;
    readonly #driver: StorageDriver;
    readonly #ready: Promise<void>;
    readonly #services: TServices | Record<never, never>;
    readonly #maintenance: MaintenanceController;
    readonly $collections: DurableObjectCollectionsApi<TCollections>;

    constructor(state: DurableObjectState, env: TEnv) {
      this.#services = createServices ? createServices({ env }) : {};
      this.#state = state;
      const registry = compileIndexRegistry(collections);
      const rawStorage = createDurableObjectStorage(state.storage, registry);
      initializeMaintenanceLayout(state.storage.sql);
      this.#maintenance = new MaintenanceController(state.storage);
      this.#driver = applyStorageLogging(
        createMigratingStorage(collections, rawStorage, logger),
        logger,
      );
      this.#ready = state.blockConcurrencyWhile(async () => {
        await this.#maintenance.cleanupAbandoned();
        await reconcileCollectionIndexes({
          sql: state.storage.sql,
          collections,
          storage: this.#driver,
          registry,
        });
        await seedCollections(collections, this.#driver, logger);
      });
      this.$collections = createDurableObjectCollectionsApi(
        createMaintenanceGatedCollections(
          createTrustedCollections(
            collections,
            afterInitialization(this.#driver, this.#ready),
            logger,
          ),
          this.#maintenance,
        ),
        collections,
        this.#maintenance,
        this.#ready,
        logger,
      );
    }

    async fetch(request: Request): Promise<Response> {
      const tracer = resolveTracer(options);
      const execute = async (): Promise<Response> => {
        const extracted = extractTraceContext(request.headers);
        const executeWithContext = async (): Promise<Response> => {
          let invocation: PublicRequest | undefined;
          try {
            const body = parseWireRequest(await request.text());
            const { context, ...decoded } = body;
            invocation = decoded;
            assertTenantMatchesDurableObjectName(this.#state.id.name, context);
            await this.#ready;
            return await this.#maintenance.runNormal(async () => {
              const local = await resolveLocalExecution({
                collections,
                registry,
                logger,
                services: this.#services,
                storage: tracer ? tracedStorage(this.#driver) : this.#driver,
                spanKind: "server",
                parentSpan: extracted?.span,
                request,
              });
              return decoded.kind === "batch"
                ? local.executeBatchHttp(context, decoded.items)
                : local.executeHttp(context, decoded);
            });
          } catch (err) {
            return errorResponse(err, logger, invocation, request);
          }
        };
        return extracted
          ? extracted.runWithActiveContext(executeWithContext)
          : executeWithContext();
      };
      return tracer ? bindTracer(tracer, execute) : execute();
    }
  };
}

export async function seedCollections(
  collections: Record<string, CollectionDefinition>,
  driver: StorageDriver,
  logger?: InternalLogger,
): Promise<void> {
  for (const [collection, definition] of Object.entries(collections)) {
    if (!definition.seed) continue;

    const documents = await definition.seed();
    for (const [id, data] of Object.entries(documents)) {
      if (await driver.get(collection, id)) continue;
      await storageAdd(definition, driver, collection, data, { id }, logger);
    }
  }
}

function afterInitialization(driver: StorageDriver, ready: Promise<void>): StorageDriver {
  return {
    async get(resource, id) {
      await ready;
      return driver.get(resource, id);
    },
    async put(resource, doc) {
      await ready;
      return driver.put(resource, doc);
    },
    async delete(resource, id) {
      await ready;
      return driver.delete(resource, id);
    },
    async list(resource, options, plan) {
      await ready;
      return driver.list(resource, options, plan);
    },
    async transaction(callback) {
      await ready;
      return driver.transaction(callback);
    },
  };
}

function assertTenantMatchesDurableObjectName(
  name: string | undefined,
  context: Record<string, unknown>,
): void {
  if (typeof name === "string" && name.length > 0 && name !== context.tenantId) {
    throw new ForbiddenError("Tenant mismatch");
  }
}
