import type { ActionRegistry } from "./action";
import { executeAction, type ActionInvocation } from "./action-executor";
import {
  applyStorageLogging,
  debugInvocationFields,
  errorResponse,
  invocationFields,
  toWireFailure,
} from "./context/runtime";
import type { InternalCollectionsOptions } from "./context/types";
import { ForbiddenError } from "./errors";
import { createTrustedCollections, executeOperation, type ExecuteRequest } from "./executor";
import type { PublicRequest } from "./http";
import { withLoggedSpan, emitFailure, type InternalLogger } from "./logging";
import { compileIndexRegistry } from "./indexes";
import { reconcileCollectionIndexes } from "./index-reconcile";
import { createMigratingStorage } from "./migrations";
import { invocationSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { decodeWireRequest, type WireResponse } from "./protocol";
import { createDurableObjectStorage } from "./storage";
import { bindTracer, extractTraceContext, resolveTracer, tracedStorage } from "./tracing";
import { TAKIBI_TRUSTED_RESET_STORAGE } from "./trusted.server";
import { storageAdd } from "./typed-storage";
import type {
  CollectionDefinition,
  CollectionsDef,
  StorageDriver,
  TrustedCollectionsApi,
} from "./types";

type DurableObjectClass<TCollections> = new (
  state: DurableObjectState,
  env: unknown,
) => DurableObject & {
  $collections: TrustedCollectionsApi<TCollections>;
  [TAKIBI_TRUSTED_RESET_STORAGE](): Promise<void>;
};

export function createDurableObjectClass<TCollections extends CollectionsDef>(
  collections: TCollections,
  registry: ActionRegistry,
  options: InternalCollectionsOptions,
  logger: InternalLogger | undefined,
  createServices?: (input: { env: unknown }) => unknown,
): DurableObjectClass<TCollections> {
  return class TakibiTenantObject implements DurableObject {
    readonly #state: DurableObjectState;
    readonly #driver: StorageDriver;
    readonly #ready: Promise<void>;
    readonly #services: unknown;
    readonly $collections: TrustedCollectionsApi<TCollections>;

    constructor(state: DurableObjectState, env: unknown) {
      this.#services = createServices ? createServices({ env }) : {};
      this.#state = state;
      const registry = compileIndexRegistry(collections);
      this.#driver = applyStorageLogging(
        createMigratingStorage(
          collections,
          createDurableObjectStorage(state.storage, registry),
          logger,
        ),
        logger,
      );
      this.#ready = state.blockConcurrencyWhile(async () => {
        await reconcileCollectionIndexes({
          sql: state.storage.sql,
          collections,
          storage: this.#driver,
          registry,
          logger,
        });
        await seedCollections(collections, this.#driver, logger);
      });
      this.$collections = createTrustedCollections(
        collections,
        afterInitialization(this.#driver, this.#ready),
        logger,
      );
    }

    async [TAKIBI_TRUSTED_RESET_STORAGE](): Promise<void> {
      await this.#ready;
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#state.storage.deleteAll();
        const registry = compileIndexRegistry(collections);
        const driver = applyStorageLogging(
          createMigratingStorage(
            collections,
            createDurableObjectStorage(this.#state.storage, registry),
            logger,
          ),
          logger,
        );
        await reconcileCollectionIndexes({
          sql: this.#state.storage.sql,
          collections,
          storage: driver,
          registry,
          logger,
        });
        await seedCollections(collections, driver, logger);
      });
    }

    async fetch(request: Request): Promise<Response> {
      const tracer = resolveTracer(options);
      const execute = async (): Promise<Response> => {
        const extracted = extractTraceContext(request.headers);
        const executeWithContext = async (): Promise<Response> => {
          let invocation: PublicRequest | undefined;
          try {
            const body = decodeWireRequest(await request.json());
            if (body.kind === "batch") {
              invocation = { kind: "batch", items: body.items };
              assertTenantMatchesDurableObjectName(this.#state.id.name, body.context);
              await this.#ready;
              const driver = tracer ? tracedStorage(this.#driver) : this.#driver;
              const results: WireResponse[] = [];
              for (const item of body.items) {
                try {
                  const data = await withLoggedSpan(
                    logger,
                    {
                      name: TAKIBI_SPAN.executor,
                      kind: "server",
                      attributes: invocationSpanAttributes(item),
                    },
                    { event: "takibi.executor", ...debugInvocationFields(item) },
                    () => executeOperation(collections, driver, body.context, item, logger),
                    extracted?.span,
                  );
                  results.push({ ok: true, data });
                } catch (error) {
                  const wire = toWireFailure(error);
                  emitFailure(logger, wire.error, invocationFields(item));
                  results.push(wire);
                }
              }
              return Response.json({ ok: true, data: results } satisfies WireResponse);
            }
            const { context, ...decodedInvocation } = body;
            invocation = decodedInvocation;
            assertTenantMatchesDurableObjectName(this.#state.id.name, context);
            await this.#ready;
            const driver = tracer ? tracedStorage(this.#driver) : this.#driver;
            const data = await withLoggedSpan(
              logger,
              {
                name: TAKIBI_SPAN.executor,
                kind: "server",
                attributes: invocationSpanAttributes(decodedInvocation),
              },
              { event: "takibi.executor", ...debugInvocationFields(decodedInvocation) },
              () =>
                decodedInvocation.kind === "action"
                  ? executeAction(
                      registry,
                      collections,
                      driver,
                      context,
                      decodedInvocation as ActionInvocation,
                      logger,
                      this.#services,
                    )
                  : executeOperation(
                      collections,
                      driver,
                      context,
                      decodedInvocation as ExecuteRequest,
                      logger,
                    ),
              extracted?.span,
            );
            return Response.json({ ok: true, data } satisfies WireResponse);
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
