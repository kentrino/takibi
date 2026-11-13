import {
  TakibiError,
  type ActionRegistry,
  type CollectionDefinition,
  type CollectionsDef,
  type DurableObjectCollectionsApi,
} from "@takibi/api";
import {
  attachSnapshotOperations,
  createMaintenanceGatedCollections,
  initializeMaintenanceLayout,
  MaintenanceController,
  SqliteMaintenanceBackend,
} from "@takibi/snapshot";
import {
  compileIndexRegistry,
  createSqliteStorage,
  observeCommits,
  reconcileCollectionIndexes,
  type SqlExecutor,
  type StorageDriver,
} from "@takibi/storage";
import { applyStorageLogging } from "./context/runtime";
import { createTrustedCollections } from "./executor";
import { resolveLocalExecution, type LocalExecution } from "./invocation-execution";
import type { InternalLogger } from "./logging";
import { createMigratingStorage } from "./migrations";
import { createTakibiSnapshotLifecycle } from "./snapshot";
import { tracedStorage, type SpanContext, type SpanKind } from "./tracing";
import { storageAdd } from "./typed-storage";
import { WatchRuntime, type WatchHost, type WatchSocket } from "./watch-runtime";

/** What a tenant runtime needs from the process that hosts it. */
export interface TenantHost<TUpgrade = Response> {
  /**
   * Run startup so that no other event reaches this tenant until it settles,
   * and return its completion.
   */
  runStartup(startup: () => Promise<void>): Promise<void>;
  /** Present when the host can carry watch sockets. */
  readonly watch?: WatchHost<TUpgrade>;
}

export type TenantRuntimeInput<TCollections extends CollectionsDef, TUpgrade = Response> = {
  collections: TCollections;
  registry: ActionRegistry;
  logger: InternalLogger | undefined;
  services: unknown;
  sql: SqlExecutor;
  host: TenantHost<TUpgrade>;
};

export type TenantExecutionInput = {
  request: Request;
  /** Wrap storage in tracing spans (a tracer is bound for this execution). */
  traced: boolean;
  spanKind: SpanKind;
  parentSpan: SpanContext | undefined;
};

/** One tenant's storage, maintenance, watch, and request execution over a SQL port. */
export type TenantRuntime<TCollections extends CollectionsDef, TUpgrade = Response> = {
  /** Settles when startup finished; rejects with the startup failure. */
  readonly ready: Promise<void>;
  /** Trusted collections with snapshot export, restore, and reset. */
  readonly collectionsApi: DurableObjectCollectionsApi<TCollections>;
  /** Await startup, then run one invocation outside any maintenance window. */
  execute<T>(input: TenantExecutionInput, run: (local: LocalExecution) => Promise<T>): Promise<T>;
  /** Await startup, then open a watch through the host. */
  upgradeWatch(request: Request): Promise<TUpgrade>;
  /** A client sent a frame; watch sockets are server-push only. */
  watchMessage(socket: WatchSocket): void;
  watchClose(socket: WatchSocket, code?: number): void;
};

/**
 * Assemble one tenant: storage layout, maintenance, migrating and logged
 * storage, commit fan-out to watch, and the startup sequence
 * initialize -> maintenance layout -> cleanup -> index reconcile -> seed -> watch recover.
 */
export function createTenantRuntime<TCollections extends CollectionsDef, TUpgrade = Response>(
  input: TenantRuntimeInput<TCollections, TUpgrade>,
): TenantRuntime<TCollections, TUpgrade> {
  const { collections, registry, logger, services, sql, host } = input;
  const indexRegistry = compileIndexRegistry(collections);
  const rawStorage = createSqliteStorage(sql, indexRegistry);
  let watch: WatchRuntime<TUpgrade> | undefined;
  const maintenance = new MaintenanceController(new SqliteMaintenanceBackend(sql), (purpose) =>
    watch?.maintenanceChanged(purpose),
  );
  const migrating = createMigratingStorage(collections, rawStorage, logger);
  // Commit observation only feeds watch fan-out.
  const driver = applyStorageLogging(
    host.watch ? observeCommits(migrating, (changed) => watch?.invalidate(changed)) : migrating,
    logger,
  );
  if (host.watch) {
    watch = new WatchRuntime(host.watch, collections, driver, maintenance, logger);
  }
  const ready = host.runStartup(async () => {
    await rawStorage.initialize();
    await initializeMaintenanceLayout(sql);
    await maintenance.cleanupAbandoned();
    await reconcileCollectionIndexes({
      sql,
      collections,
      storage: driver,
      registry: indexRegistry,
    });
    await seedCollections(collections, driver, logger);
    watch?.recover();
  });
  const collectionsApi = attachSnapshotOperations(
    createMaintenanceGatedCollections(
      createTrustedCollections(collections, afterInitialization(driver, ready), logger),
      maintenance,
    ),
    maintenance,
    ready,
    createTakibiSnapshotLifecycle(collections, logger),
  );

  return {
    ready,
    collectionsApi,
    async execute(execution, run) {
      await ready;
      return maintenance.runNormal(async () => {
        const local = await resolveLocalExecution({
          collections,
          registry,
          logger,
          services,
          storage: execution.traced ? tracedStorage(driver) : driver,
          spanKind: execution.spanKind,
          parentSpan: execution.parentSpan,
          request: execution.request,
        });
        return run(local);
      });
    },
    async upgradeWatch(request) {
      await ready;
      if (!watch) {
        throw new TakibiError("WATCH_UNAVAILABLE", "This host does not support watch", 400);
      }
      return watch.upgrade(request);
    },
    watchMessage(socket) {
      watch?.protocolError(socket);
    },
    watchClose(socket, code) {
      watch?.close(socket, code);
    },
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
