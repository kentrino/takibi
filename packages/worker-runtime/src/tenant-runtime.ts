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
  MaintenanceController,
  SqliteMaintenanceBackend,
  type MaintenanceBackend,
} from "@takibi/snapshot";
import {
  compileIndexRegistry,
  observeCommits,
  openSqliteStorage,
  reconcileCollectionIndexes,
  type SqlExecutor,
  type SqliteStorage,
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
  /**
   * Settles when startup finished; rejects with the startup failure. The
   * runtime itself observes it: a failure is reported by every later call and,
   * if no call reported it, by `close()`.
   */
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
  /**
   * Stop accepting executions and watch upgrades (they reject with
   * `TENANT_CLOSED`), then wait for startup and in-flight executions to settle.
   * Rejects with the startup failure if startup failed and no call reported it
   * yet. Idempotent. The host closes the SQL executor after it settles.
   */
  close(): Promise<void>;
};

/**
 * Assemble one tenant: storage, maintenance, migrating and logged storage,
 * commit fan-out to watch, and the single startup sequence
 * open storage layout -> open maintenance layout -> maintenance cleanup ->
 * index reconcile -> seed -> watch recover.
 *
 * Startup is the only place that opens the database. Components wired before
 * it (the maintenance controller, migrating storage, watch, and the trusted
 * collections) reach the opened storage and backend through forwarders that
 * throw before startup opened them; every entry point waits for startup first.
 */
export function createTenantRuntime<TCollections extends CollectionsDef, TUpgrade = Response>(
  input: TenantRuntimeInput<TCollections, TUpgrade>,
): TenantRuntime<TCollections, TUpgrade> {
  const { collections, registry, logger, services, sql, host } = input;
  const indexRegistry = compileIndexRegistry(collections);
  let opened: { storage: SqliteStorage; backend: SqliteMaintenanceBackend } | undefined;
  const current = () => {
    if (opened === undefined) {
      throw new TakibiError("TENANT_NOT_STARTED", "Tenant storage used before startup", 500);
    }
    return opened;
  };
  let watch: WatchRuntime<TUpgrade> | undefined;
  const maintenance = new MaintenanceController(
    openedBackend(() => current().backend),
    (purpose) => watch?.maintenanceChanged(purpose),
  );
  const migrating = createMigratingStorage(
    collections,
    openedStorage(() => current().storage),
    logger,
  );
  // Commit observation only feeds watch fan-out.
  const driver = applyStorageLogging(
    host.watch ? observeCommits(migrating, (changed) => watch?.invalidate(changed)) : migrating,
    logger,
  );
  if (host.watch) {
    watch = new WatchRuntime(host.watch, collections, driver, maintenance, logger);
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let startupFailure: { error: unknown; reported: boolean } | undefined;
  const inflight = new Set<Promise<unknown>>();
  const ready = host.runStartup(async () => {
    const storage = await openSqliteStorage(sql, indexRegistry);
    opened = { storage, backend: await SqliteMaintenanceBackend.open(sql) };
    await maintenance.cleanupAbandoned();
    await reconcileCollectionIndexes({
      storage,
      reader: driver,
      collections,
      registry: indexRegistry,
    });
    await seedCollections(collections, driver, logger);
    watch?.recover();
  });
  const startupSettled = ready.then(
    () => undefined,
    (error: unknown) => {
      startupFailure = { error, reported: false };
    },
  );
  /** Wait for startup; reject when closed or with the startup failure. */
  const started = async (): Promise<void> => {
    if (closed) throw closedError();
    await startupSettled;
    if (startupFailure !== undefined) {
      startupFailure.reported = true;
      throw startupFailure.error;
    }
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    );
    return work;
  };
  const collectionsApi = attachSnapshotOperations(
    createMaintenanceGatedCollections(
      createTrustedCollections(collections, afterStartup(driver, started), logger),
      maintenance,
    ),
    maintenance,
    ready,
    createTakibiSnapshotLifecycle(collections, logger),
  );

  return {
    ready,
    collectionsApi,
    execute(execution, run) {
      return track(
        started().then(() =>
          maintenance.runNormal(async () => {
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
          }),
        ),
      );
    },
    async upgradeWatch(request) {
      await started();
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
    close() {
      closed = true;
      return (closing ??= (async () => {
        await startupSettled;
        while (inflight.size > 0) await Promise.allSettled(inflight);
        if (startupFailure !== undefined && !startupFailure.reported) {
          startupFailure.reported = true;
          throw startupFailure.error;
        }
      })());
    },
  };
}

function closedError(): TakibiError {
  return new TakibiError("TENANT_CLOSED", "This tenant runtime is closed", 503);
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

function afterStartup(driver: StorageDriver, started: () => Promise<void>): StorageDriver {
  return {
    async get(resource, id) {
      await started();
      return driver.get(resource, id);
    },
    async put(resource, doc) {
      await started();
      return driver.put(resource, doc);
    },
    async delete(resource, id) {
      await started();
      return driver.delete(resource, id);
    },
    async list(resource, options, plan) {
      await started();
      return driver.list(resource, options, plan);
    },
    async transaction(callback) {
      await started();
      return driver.transaction(callback);
    },
  };
}

/** Storage calls forwarded to the storage startup opened. */
function openedStorage(current: () => StorageDriver): StorageDriver {
  return {
    get: (resource, id) => current().get(resource, id),
    put: (resource, doc) => current().put(resource, doc),
    delete: (resource, id) => current().delete(resource, id),
    list: (resource, options, plan) => current().list(resource, options, plan),
    transaction: (callback) => current().transaction(callback),
  };
}

/** Maintenance backend calls forwarded to the backend startup opened. */
function openedBackend(current: () => MaintenanceBackend): MaintenanceBackend {
  return {
    cleanupAbandoned: () => current().cleanupAbandoned(),
    acquire: (owner, purpose, ttl) => current().acquire(owner, purpose, ttl),
    renew: (owner, purpose, ttl) => current().renew(owner, purpose, ttl),
    release: (owner) => current().release(owner),
    scanDocuments: (cursor, limit) => current().scanDocuments(cursor, limit),
    clearStaging: (owner) => current().clearStaging(owner),
    stageDocument: (owner, document) => current().stageDocument(owner, document),
    stageUnique: (owner, collection, constraint, valueKey, documentId) =>
      current().stageUnique(owner, collection, constraint, valueKey, documentId),
    hasStagedDocument: (owner, collection, id) =>
      current().hasStagedDocument(owner, collection, id),
    finalizeRestore: (owner, seeds, expected) => current().finalizeRestore(owner, seeds, expected),
    reset: (owner, seeds) => current().reset(owner, seeds),
  };
}
