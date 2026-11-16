import { BadRequestError, MaintenanceLockedError, type CollectionsDef } from "@takibi/api";
import {
  decodeWatchAttachment,
  WATCH_VERSION,
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

/** WHATWG `WebSocket.OPEN`; a literal so the runtime needs no `WebSocket` global. */
const SOCKET_OPEN = 1;

/** The subset of a server-side WebSocket the watch runtime drives. */
export interface WatchSocket {
  readonly readyState: number;
  send(message: string): void;
  close(code?: number): void;
  /** The string the host stored when it accepted this socket. */
  deserializeAttachment(): unknown;
}

/**
 * What watch needs from its host. The host's live sockets, each carrying the
 * serialized attachment it was accepted with, are the only watch registry.
 */
export interface WatchHost<TUpgrade = Response> {
  /** Every live watch socket accepted by this tenant. */
  sockets(): readonly WatchSocket[];
  /**
   * Register a new server socket carrying `attachment`. `respond` is called
   * after the initial snapshot was sent and produces the host's upgrade result.
   */
  accept(attachment: string): { socket: WatchSocket; respond: () => TUpgrade };
  /** Keep the host alive until background fan-out settles. */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Tell a client that sent a frame that watch sockets are server-push only,
 * then close the socket terminally. Needs nothing from the tenant's database.
 */
export function sendWatchProtocolError(socket: WatchSocket): void {
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
  closeWatchSocket(socket, WATCH_PROTOCOL_CLOSE);
}

/** Close a watch socket, isolating sockets that are already gone. */
export function closeWatchSocket(socket: WatchSocket, code = 1000): void {
  try {
    socket.close(code);
  } catch {
    /* Isolate sockets that are already gone. */
  }
}

export class WatchRuntime<TUpgrade = Response> {
  #dirty = new Set<string>();
  #scheduled = false;
  constructor(
    private readonly host: WatchHost<TUpgrade>,
    private readonly collections: CollectionsDef,
    private readonly storage: StorageDriver,
    private readonly maintenance: MaintenanceController,
    private readonly logger: InternalLogger | undefined,
  ) {}

  recover(): void {
    for (const socket of this.host.sockets()) {
      const attachment = this.#attachment(socket);
      if (attachment) this.#dirty.add(attachment.collection);
    }
    this.#schedule();
  }

  invalidate = (collections: ReadonlySet<string>): void => {
    if (this.host.sockets().length === 0) return;
    for (const collection of collections) this.#dirty.add(collection);
    this.#schedule();
  };

  maintenanceChanged(purpose: MaintenancePurpose | undefined): void {
    if (purpose === "restore" || purpose === "reset") {
      for (const socket of this.host.sockets()) this.close(socket, WATCH_MAINTENANCE_CLOSE);
    }
    if (purpose === undefined) this.#schedule();
  }

  async upgrade(request: Request): Promise<TUpgrade> {
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
        const { socket, respond } = this.host.accept(serialized);
        try {
          socket.send(snapshot);
        } catch {
          this.close(socket, WATCH_PROTOCOL_CLOSE);
        }
        return respond();
      }),
    );
  }

  protocolError(socket: WatchSocket): void {
    sendWatchProtocolError(socket);
  }
  close(socket: WatchSocket, code = 1000): void {
    closeWatchSocket(socket, code);
  }

  #attachment(socket: WatchSocket): WatchAttachment | undefined {
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
    this.host.waitUntil(pending);
  }

  async #flush(): Promise<void> {
    const changed = this.#dirty;
    this.#dirty = new Set();
    for (const socket of this.host.sockets()) {
      if (socket.readyState !== SOCKET_OPEN) continue;
      const attachment = this.#attachment(socket);
      if (!attachment || !changed.has(attachment.collection)) continue;
      try {
        await this.maintenance.runNormal(() =>
          this.storage.transaction(async (storage) => {
            const snapshot = await this.#snapshot(attachment, storage);
            if (this.maintenance.blocked) throw new MaintenanceLockedError();
            if (socket.readyState === SOCKET_OPEN) socket.send(snapshot);
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
