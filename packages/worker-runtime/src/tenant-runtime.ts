import {
  TakibiError,
  type ActionRegistry,
  type CollectionDefinition,
  type CollectionsDef,
  type DurableObjectCollectionsApi,
  type TrustedCollectionsApi,
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
  /**
   * Settles when startup finished; rejects with the startup failure. The
   * runtime itself observes it: a failure is reported by every later call and,
   * if no call reported it, by `close()`.
   */
  readonly ready: Promise<void>;
  /**
   * Trusted collections with snapshot export, restore, and reset. Every method
   * is an entry point like `execute`: it waits for startup and is refused with
   * `TENANT_CLOSED` once `close()` was called.
   */
  readonly collectionsApi: DurableObjectCollectionsApi<TCollections>;
  /** Await startup, then run one invocation outside any maintenance window. */
  execute<T>(input: TenantExecutionInput, run: (local: LocalExecution) => Promise<T>): Promise<T>;
  /** Await startup, then open a watch through the host. */
  upgradeWatch(request: Request): Promise<TUpgrade>;
  /** A client sent a frame; watch sockets are server-push only. */
  watchMessage(socket: WatchSocket): void;
  watchClose(socket: WatchSocket, code?: number): void;
  /**
   * Stop admitting work: from this call on, every entry point (`execute`,
   * `upgradeWatch`, each `collectionsApi` method, and further reads of an
   * export stream) rejects with `TENANT_CLOSED`. Then wait for startup and for
   * all work started through the runtime (executions, trusted collection
   * calls, snapshot operations, watch fan-out handed to `waitUntil`), and
   * cancel export streams still open. When it settles, nothing started through
   * the runtime touches the database any more; the host closes the SQL
   * executor then.
   *
   * A startup failure is reported once: by every call that waited for startup,
   * or, when no call did, by this promise rejecting with it. Idempotent: every
   * call returns the same promise, so repeated calls share that one outcome.
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
 * throw before startup opened them; every entry point goes through one
 * admission step that waits for startup and tracks the work for `close()`.
 */
export function createTenantRuntime<TCollections extends CollectionsDef, TUpgrade = Response>(
  input: TenantRuntimeInput<TCollections, TUpgrade>,
): TenantRuntime<TCollections, TUpgrade> {
  const { collections, registry, logger, services, sql, host } = input;
  const indexRegistry = compileIndexRegistry(collections);
  let opened: { storage: StorageDriver; backend: SqliteMaintenanceBackend } | undefined;
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
  let closed = false;
  let closing: Promise<void> | undefined;
  let startupFailure: { error: unknown; reported: boolean } | undefined;
  const inflight = new Set<Promise<unknown>>();
  const openExports = new Set<() => Promise<void>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    );
    return work;
  };
  if (host.watch) {
    const watchHost = host.watch;
    watch = new WatchRuntime(
      {
        sockets: () => watchHost.sockets(),
        accept: (attachment) => watchHost.accept(attachment),
        // Fan-out reads the database; close() waits for it like any other work.
        waitUntil: (promise) => watchHost.waitUntil(track(promise)),
      },
      collections,
      driver,
      maintenance,
      logger,
    );
  }
  const ready = host.runStartup(async () => {
    const { storage, indexes } = await openSqliteStorage(sql, indexRegistry);
    opened = { storage, backend: await SqliteMaintenanceBackend.open(sql) };
    await maintenance.cleanupAbandoned();
    await indexes.reconcile({ reader: driver, collections, registry: indexRegistry });
    await seedCollections(collections, driver, logger);
    watch?.recover();
  });
  const startupSettled = ready.then(
    () => undefined,
    (error: unknown) => {
      startupFailure = { error, reported: false };
    },
  );
  /** Wait for startup; reject with the startup failure, which then counts as reported. */
  const started = async (): Promise<void> => {
    await startupSettled;
    if (startupFailure !== undefined) {
      startupFailure.reported = true;
      throw startupFailure.error;
    }
  };
  /**
   * The single admission point of every entry point: refuse once closing has
   * begun, otherwise wait for startup and run `operation` as tracked work.
   */
  const admit = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(closedError());
    return track(started().then(operation));
  };
  /**
   * An export stream keeps reading the database after `$exportSnapshot`
   * settled. Each pull is tracked work and is refused once closing has begun;
   * `close()` cancels streams still open, which releases their lease.
   */
  const trackExport = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    const reader = stream.getReader();
    let open = true;
    const finish = (reason?: unknown): Promise<void> => {
      if (!open) return Promise.resolve();
      open = false;
      openExports.delete(cancelOnClose);
      return reader.cancel(reason);
    };
    const cancelOnClose = () => finish(closedError());
    openExports.add(cancelOnClose);
    return new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (closed) {
            controller.error(closedError());
            return;
          }
          return track(
            reader.read().then(
              (result) => {
                if (result.done) {
                  open = false;
                  openExports.delete(cancelOnClose);
                  controller.close();
                } else {
                  controller.enqueue(result.value);
                }
              },
              (error: unknown) => {
                open = false;
                openExports.delete(cancelOnClose);
                throw error;
              },
            ),
          );
        },
        cancel: (reason) => (closed ? undefined : track(finish(reason))),
      },
      { highWaterMark: 0 },
    );
  };
  // Admission wraps the maintenance gate, as in `execute`: a closed runtime
  // reports TENANT_CLOSED before a held lease, and a call waiting for startup
  // does not count as a running normal operation yet.
  const collectionsApi = attachSnapshotOperations(
    admitCollections(
      createMaintenanceGatedCollections(
        createTrustedCollections(collections, driver, logger),
        maintenance,
      ),
      admit,
    ),
    maintenance,
    (operation) =>
      admit(async () => {
        const result = await operation();
        // Only `$exportSnapshot` resolves with a stream; it keeps reading the database.
        return result instanceof ReadableStream ? (trackExport(result) as typeof result) : result;
      }),
    createTakibiSnapshotLifecycle(collections, logger),
  );

  return {
    ready,
    collectionsApi,
    execute(execution, run) {
      return admit(() =>
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
      );
    },
    upgradeWatch(request) {
      return admit(async () => {
        if (!watch) {
          throw new TakibiError("WATCH_UNAVAILABLE", "This host does not support watch", 400);
        }
        return watch.upgrade(request);
      });
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
        const drain = async () => {
          while (inflight.size > 0) await Promise.allSettled(inflight);
        };
        await drain();
        // No pull runs any more; cancel export streams still open so their
        // lease is released before the database closes.
        for (const cancel of openExports) void track(cancel());
        await drain();
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

/** Route every trusted collection method and `$transaction` through `admit`. */
function admitCollections<TCollections extends CollectionsDef>(
  api: TrustedCollectionsApi<TCollections>,
  admit: <T>(operation: () => Promise<T>) => Promise<T>,
): TrustedCollectionsApi<TCollections> {
  const collectionProxies = new Map<PropertyKey, object>();
  const admitted =
    (target: object, member: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      admit(async () => Reflect.apply(member, target, args));
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "$transaction" && typeof value === "function") {
        return admitted(target, value as (...args: unknown[]) => unknown);
      }
      if (typeof value !== "object" || value === null) return value;
      const cached = collectionProxies.get(property);
      if (cached !== undefined) return cached;
      const proxy = new Proxy(value, {
        get(collection, method, collectionReceiver) {
          const member = Reflect.get(collection, method, collectionReceiver) as unknown;
          return typeof member === "function"
            ? admitted(collection, member as (...args: unknown[]) => unknown)
            : member;
        },
      });
      collectionProxies.set(property, proxy);
      return proxy;
    },
  });
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
