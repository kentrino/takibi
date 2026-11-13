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
} from "@takibi/snapshot";
import {
  compileIndexRegistry,
  observeCommits,
  openSqliteStorage,
  type IndexRegistry,
  type SqlExecutor,
  type SqliteIndexAdmin,
  type StorageDriver,
} from "@takibi/storage";
import { applyStorageLogging } from "./context/runtime";
import { createTrustedCollections, TRUSTED_COLLECTION_METHODS } from "./executor";
import { resolveLocalExecution, type LocalExecution } from "./invocation-execution";
import type { InternalLogger } from "./logging";
import { createMigratingStorage } from "./migrations";
import { createTakibiSnapshotLifecycle } from "./snapshot";
import { tracedStorage, type SpanContext, type SpanKind } from "./tracing";
import { storageAdd } from "./typed-storage";
import {
  closeWatchSocket,
  sendWatchProtocolError,
  WatchRuntime,
  type WatchHost,
  type WatchSocket,
} from "./watch-runtime";

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
 * Assemble one tenant behind a single startup sequence:
 * open database -> maintenance cleanup -> index reconcile -> seed -> watch recover.
 *
 * Startup is the only place that opens the database, and everything that
 * needs the opened database (maintenance, migrating and logged storage, watch,
 * trusted collections) is built there, over it. What exists before startup
 * holds no database handle: `collectionsApi`, `execute`, and `upgradeWatch`
 * reach the started tenant only through one admission step, which waits for
 * startup, refuses work once closing began, and tracks the work for
 * `close()`. Watch socket events need nothing from the database.
 */
export function createTenantRuntime<TCollections extends CollectionsDef, TUpgrade = Response>(
  input: TenantRuntimeInput<TCollections, TUpgrade>,
): TenantRuntime<TCollections, TUpgrade> {
  const { collections, registry, logger, services, sql, host } = input;
  const indexRegistry = compileIndexRegistry(collections);
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
  let tenant: StartedTenant<TCollections, TUpgrade> | undefined;
  const ready = host.runStartup(async () => {
    const database = await openTenantDatabase(sql, indexRegistry);
    const started = assembleTenant(input, database, track);
    await started.maintenance.cleanupAbandoned();
    await database.indexes.reconcile({
      reader: started.driver,
      collections,
      registry: indexRegistry,
    });
    await seedCollections(collections, started.driver, logger);
    started.watch?.recover();
    tenant = started;
  });
  const startupSettled = ready.then(
    () => undefined,
    (error: unknown) => {
      startupFailure = { error, reported: false };
    },
  );
  /** Wait for startup; reject with the startup failure, which then counts as reported. */
  const started = async (): Promise<StartedTenant<TCollections, TUpgrade>> => {
    await startupSettled;
    if (startupFailure !== undefined) {
      startupFailure.reported = true;
      throw startupFailure.error;
    }
    if (tenant === undefined) {
      throw new Error("TenantHost.runStartup settled without running startup");
    }
    return tenant;
  };
  /**
   * The single admission point of every entry point: refuse once closing has
   * begun, otherwise wait for startup and run `operation` on the started
   * tenant as tracked work.
   */
  const admit = <T>(
    operation: (tenant: StartedTenant<TCollections, TUpgrade>) => Promise<T>,
  ): Promise<T> => {
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
    admittedCollections(collections, (call) => admit((tenant) => call(tenant.collections))),
    { operation: (run) => admit((tenant) => run(tenant.maintenance)), exportStream: trackExport },
    createTakibiSnapshotLifecycle(collections, logger),
  );

  return {
    ready,
    collectionsApi,
    execute(execution, run) {
      return admit((tenant) =>
        tenant.maintenance.runNormal(async () => {
          const local = await resolveLocalExecution({
            collections,
            registry,
            logger,
            services,
            storage: execution.traced ? tracedStorage(tenant.driver) : tenant.driver,
            spanKind: execution.spanKind,
            parentSpan: execution.parentSpan,
            request: execution.request,
          });
          return run(local);
        }),
      );
    },
    upgradeWatch(request) {
      return admit(async (tenant) => {
        if (!tenant.watch) {
          throw new TakibiError("WATCH_UNAVAILABLE", "This host does not support watch", 400);
        }
        return tenant.watch.upgrade(request);
      });
    },
    watchMessage(socket) {
      if (host.watch) sendWatchProtocolError(socket);
    },
    watchClose(socket, code) {
      if (host.watch) closeWatchSocket(socket, code);
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

/** One tenant's opened database: data plane, index control plane, and maintenance, on one executor. */
type TenantDatabase = {
  storage: StorageDriver;
  indexes: SqliteIndexAdmin;
  maintenance: SqliteMaintenanceBackend;
};

/** Open the document/index layout, then the maintenance layout, on `sql`. */
async function openTenantDatabase(
  sql: SqlExecutor,
  registry: IndexRegistry,
): Promise<TenantDatabase> {
  const { storage, indexes } = await openSqliteStorage(sql, registry);
  return { storage, indexes, maintenance: await SqliteMaintenanceBackend.open(sql) };
}

/** What startup builds over the opened database; every admitted entry point runs on it. */
type StartedTenant<TCollections extends CollectionsDef, TUpgrade> = {
  maintenance: MaintenanceController;
  /** Migrating, logged storage that also feeds watch fan-out when the host carries watch. */
  driver: StorageDriver;
  /** Trusted collections behind the maintenance gate, not yet admitted. */
  collections: TrustedCollectionsApi<TCollections>;
  watch: WatchRuntime<TUpgrade> | undefined;
};

/** Wire maintenance, storage wrappers, watch, and trusted collections over `database`. */
function assembleTenant<TCollections extends CollectionsDef, TUpgrade>(
  input: TenantRuntimeInput<TCollections, TUpgrade>,
  database: TenantDatabase,
  track: <T>(work: Promise<T>) => Promise<T>,
): StartedTenant<TCollections, TUpgrade> {
  const { collections, logger, host } = input;
  // Watch and maintenance refer to each other: a maintenance window closes or
  // resumes watches, and watch reads run as normal work under maintenance.
  // Both are built here, before any commit or maintenance change can happen.
  let watch: WatchRuntime<TUpgrade> | undefined;
  const maintenance = new MaintenanceController(database.maintenance, (purpose) =>
    watch?.maintenanceChanged(purpose),
  );
  const migrating = createMigratingStorage(collections, database.storage, logger);
  // Commit observation only feeds watch fan-out.
  const driver = applyStorageLogging(
    host.watch ? observeCommits(migrating, (changed) => watch?.invalidate(changed)) : migrating,
    logger,
  );
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
  return {
    maintenance,
    driver,
    collections: createMaintenanceGatedCollections(
      createTrustedCollections(collections, driver, logger),
      maintenance,
    ),
    watch,
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

/**
 * The trusted collections API that exists before startup: every collection
 * method and `$transaction` goes through `admit`, which waits for startup and
 * calls the same method on the API startup built.
 */
function admittedCollections<TCollections extends CollectionsDef>(
  collections: TCollections,
  admit: <T>(call: (api: TrustedCollectionsApi<TCollections>) => Promise<T>) => Promise<T>,
): TrustedCollectionsApi<TCollections> {
  type Methods = Record<string, (...args: unknown[]) => Promise<unknown>>;
  const api = Object.create(null) as Record<string, unknown>;
  for (const name of Object.keys(collections)) {
    api[name] = Object.fromEntries(
      TRUSTED_COLLECTION_METHODS.map((method) => [
        method,
        (...args: unknown[]) =>
          admit((started) => (started[name as keyof typeof started] as Methods)[method]!(...args)),
      ]),
    );
  }
  api.$transaction = (
    callback: ($collections: TrustedCollectionsApi<TCollections>) => Promise<unknown>,
  ) => admit((started) => started.$transaction(callback));
  return api as TrustedCollectionsApi<TCollections>;
}
