import { BadRequestError, MaintenanceLockedError, type CollectionsDef } from "@takibi/api";
import {
  decodeWatchAttachment,
  WATCH_VERSION,
  WATCH_PROTOCOL,
  WATCH_PROTOCOL_CLOSE,
  WATCH_ERROR_CLOSE,
  WATCH_MAINTENANCE_CLOSE,
  type WatchAttachment,
} from "@takibi/protocol";
import type { StorageDriver } from "@takibi/storage";
import type { MaintenanceController, MaintenancePurpose } from "@takibi/snapshot";
import { executeOperation } from "./executor";
import { normalizeInvocationFailure } from "./context/runtime";
import { WATCH_HEADER, assertWatchProtocols, encodeWatchAttachment } from "./watch-upgrade";
import type { InternalLogger } from "./logging";

/** The Hibernation sockets and their versioned attachments are the only registry. */
export class WatchRuntime {
  #dirty = new Set<string>();
  #scheduled = false;
  constructor(
    private readonly state: DurableObjectState,
    private readonly collections: CollectionsDef,
    private readonly storage: StorageDriver,
    private readonly maintenance: MaintenanceController,
    private readonly logger: InternalLogger | undefined,
  ) {}

  recover(): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = this.#attachment(socket);
      if (attachment) this.#dirty.add(attachment.collection);
    }
    this.#schedule();
  }

  invalidate = (collections: ReadonlySet<string>): void => {
    if (this.state.getWebSockets().length === 0) return;
    for (const collection of collections) this.#dirty.add(collection);
    this.#schedule();
  };

  maintenanceChanged(purpose: MaintenancePurpose | undefined): void {
    if (purpose === "restore" || purpose === "reset") {
      for (const socket of this.state.getWebSockets()) this.close(socket, WATCH_MAINTENANCE_CLOSE);
    }
    if (purpose === undefined) this.#schedule();
  }

  async upgrade(request: Request): Promise<Response> {
    assertWatchProtocols(request);
    let attachment: WatchAttachment;
    try {
      attachment = decodeWatchAttachment(
        JSON.parse(decodeURIComponent(request.headers.get(WATCH_HEADER) ?? "")),
      );
    } catch {
      throw new BadRequestError("Invalid watch attachment");
    }
    const serialized = encodeWatchAttachment(attachment);
    return this.maintenance.runNormal(() =>
      this.storage.transaction(async (storage) => {
        const snapshot = await this.#snapshot(attachment, storage);
        if (this.maintenance.blocked) throw new MaintenanceLockedError();
        const [client, server] = Object.values(new WebSocketPair());
        // serializeAttachment itself also enforces the platform's structured-clone limit.
        server.serializeAttachment(serialized);
        this.state.acceptWebSocket(server);
        try {
          server.send(snapshot);
        } catch {
          this.close(server, WATCH_PROTOCOL_CLOSE);
        }
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: { "sec-websocket-protocol": WATCH_PROTOCOL },
        });
      }),
    );
  }

  protocolError(socket: WebSocket): void {
    try {
      socket.send(
        JSON.stringify({
          version: WATCH_VERSION,
          kind: "error",
          reason: "protocol-error",
          error: normalizeInvocationFailure(
            new BadRequestError("Invalid or obsolete watch protocol"),
          ),
        }),
      );
    } catch {
      /* The terminal close code still prevents reconnect after a failed send. */
    }
    this.close(socket, WATCH_PROTOCOL_CLOSE);
  }
  close(socket: WebSocket, code = 1000): void {
    try {
      socket.close(code);
    } catch {
      /* Isolate sockets that are already gone. */
    }
  }

  #attachment(socket: WebSocket): WatchAttachment | undefined {
    try {
      const serialized: unknown = socket.deserializeAttachment();
      if (typeof serialized !== "string") throw new Error("Invalid attachment");
      const attachment = decodeWatchAttachment(JSON.parse(serialized));
      encodeWatchAttachment(attachment);
      return attachment;
    } catch {
      this.protocolError(socket);
      return undefined;
    }
  }

  async #snapshot(attachment: WatchAttachment, storage: StorageDriver): Promise<string> {
    // This runs the very same policy/range/index path as list. Expiry is local policy.
    const result = (await executeOperation(
      this.collections,
      storage,
      attachment.context,
      {
        kind: "collection",
        collection: attachment.collection,
        operation: "list",
        list: attachment.list,
      },
      this.logger,
    )) as { items: unknown[] };
    return JSON.stringify({ version: WATCH_VERSION, kind: "snapshot", items: result.items });
  }

  #schedule(): void {
    if (this.#scheduled || this.maintenance.blocked || !this.#dirty.size) return;
    this.#scheduled = true;
    const pending = Promise.resolve()
      .then(() => this.#flush())
      .finally(() => {
        this.#scheduled = false;
        this.#schedule();
      });
    this.state.waitUntil(pending);
  }

  async #flush(): Promise<void> {
    const changed = this.#dirty;
    this.#dirty = new Set();
    for (const socket of this.state.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = this.#attachment(socket);
      if (!attachment || !changed.has(attachment.collection)) continue;
      try {
        await this.maintenance.runNormal(() =>
          this.storage.transaction(async (storage) => {
            const snapshot = await this.#snapshot(attachment, storage);
            if (this.maintenance.blocked) throw new MaintenanceLockedError();
            if (socket.readyState === WebSocket.OPEN) socket.send(snapshot);
          }),
        );
      } catch (error) {
        if (error instanceof MaintenanceLockedError) {
          this.#dirty.add(attachment.collection);
          continue;
        }
        try {
          socket.send(
            JSON.stringify({
              version: WATCH_VERSION,
              kind: "error",
              reason: "server-error",
              error: normalizeInvocationFailure(error),
            }),
          );
        } catch {
          /* A broken socket does not affect the mutation or other watches. */
        }
        this.close(socket, WATCH_ERROR_CLOSE);
      }
    }
  }
}
