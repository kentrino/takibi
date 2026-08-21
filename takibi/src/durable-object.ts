import type { ActionRegistry } from "./action";
import { executeAction, type ActionInvocation } from "./action-executor";
import type { InternalCollectionsOptions } from "./context-types";
import { applyStorageLogging, debugInvocationFields, errorResponse } from "./context-runtime";
import { ForbiddenError } from "./errors";
import { createTrustedCollections, executeOperation, type ExecuteRequest } from "./executor";
import type { PublicRequest } from "./http";
import { withLoggedSpan, type InternalLogger } from "./logging";
import { createMigratingStorage } from "./migrations";
import { invocationSpanAttributes, TAKIBI_SPAN } from "./otel-helper";
import { decodeWireRequest, type WireResponse } from "./protocol";
import { createDurableObjectStorage } from "./storage";
import { bindTracer, extractTraceContext, resolveTracer, tracedStorage } from "./tracing";
import { storageAdd } from "./typed-storage";
import type { CollectionDefinition, CollectionsApi, CollectionsDef, StorageDriver } from "./types";

type DurableObjectClass<TCollections> = new (
  state: DurableObjectState,
  env: unknown,
) => DurableObject & { $collections: CollectionsApi<TCollections> };

export function createDurableObjectClass<TCollections extends CollectionsDef>(
  collections: TCollections,
  registry: ActionRegistry,
  options: InternalCollectionsOptions,
  logger: InternalLogger | undefined,
): DurableObjectClass<TCollections> {
  return class TakibiTenantObject implements DurableObject {
    readonly #state: DurableObjectState;
    readonly #driver: StorageDriver;
    readonly #ready: Promise<void>;
    readonly $collections: CollectionsApi<TCollections>;

    constructor(state: DurableObjectState, _env: unknown) {
      this.#state = state;
      this.#driver = applyStorageLogging(
        createMigratingStorage(collections, createDurableObjectStorage(state.storage), logger),
        logger,
      );
      this.#ready = state.blockConcurrencyWhile(() =>
        seedCollections(collections, this.#driver, logger),
      );
      this.$collections = createTrustedCollections(
        collections,
        afterInitialization(this.#driver, this.#ready),
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
            const body = decodeWireRequest(await request.json());
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
