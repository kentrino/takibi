import type { ActionRegistry, CollectionsDef, DurableObjectCollectionsApi } from "@takibi/api";
import { WATCH_PROTOCOL } from "@takibi/protocol";
import { errorResponse } from "./context/runtime";
import type { InternalCollectionsOptions } from "./context/types";
import { createDurableObjectSqlExecutor } from "./durable-object-sql";
import type { PublicRequest } from "./http";
import type { InternalLogger } from "./logging";
import { parseWireRequest } from "./protocol";
import { createTenantRuntime, type TenantHost, type TenantRuntime } from "./tenant-runtime";
import { bindTracer, extractTraceContext, resolveTracer } from "./tracing";

type DurableObjectClass<TCollections, TEnv> = new (
  state: DurableObjectState,
  env: TEnv,
) => DurableObject & {
  $collections: DurableObjectCollectionsApi<TCollections>;
};

/** Startup under `blockConcurrencyWhile`; watch over Hibernation API sockets. */
export function createDurableObjectHost(state: DurableObjectState): TenantHost<Response> {
  return {
    runStartup: (startup) => state.blockConcurrencyWhile(startup),
    watch: {
      sockets: () => state.getWebSockets(),
      accept(attachment) {
        const [client, server] = Object.values(new WebSocketPair());
        // serializeAttachment itself also enforces the platform's structured-clone limit.
        server.serializeAttachment(attachment);
        state.acceptWebSocket(server);
        return {
          socket: server,
          respond: () =>
            new Response(null, {
              status: 101,
              webSocket: client,
              headers: { "sec-websocket-protocol": WATCH_PROTOCOL },
            }),
        };
      },
      waitUntil: (promise) => state.waitUntil(promise),
    },
  };
}

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
    readonly #runtime: TenantRuntime<TCollections>;
    readonly $collections: DurableObjectCollectionsApi<TCollections>;

    constructor(state: DurableObjectState, env: TEnv) {
      const services = createServices ? createServices({ env }) : {};
      this.#runtime = createTenantRuntime({
        collections,
        registry,
        logger,
        services,
        sql: createDurableObjectSqlExecutor(state.storage),
        host: createDurableObjectHost(state),
      });
      this.$collections = this.#runtime.collectionsApi;
    }

    webSocketMessage(socket: WebSocket, _message: string | ArrayBuffer): void {
      this.#runtime.watchMessage(socket);
    }
    webSocketClose(socket: WebSocket): void {
      this.#runtime.watchClose(socket);
    }
    webSocketError(socket: WebSocket): void {
      this.#runtime.watchClose(socket, 1011);
    }

    async fetch(request: Request): Promise<Response> {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        try {
          return await this.#runtime.upgradeWatch(request);
        } catch (error) {
          return errorResponse(error, logger);
        }
      }
      const tracer = resolveTracer(options);
      const execute = async (): Promise<Response> => {
        const extracted = extractTraceContext(request.headers);
        const executeWithContext = async (): Promise<Response> => {
          let invocation: PublicRequest | undefined;
          try {
            const body = parseWireRequest(await request.text());
            const { context, ...decoded } = body;
            invocation = decoded;
            return await this.#runtime.execute(
              { request, traced: !!tracer, spanKind: "server", parentSpan: extracted?.span },
              (local) =>
                decoded.kind === "batch"
                  ? local.executeBatchHttp(context, decoded.items)
                  : local.executeHttp(context, decoded),
            );
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
