import { unsafeClientPropertyNames, type WatchCollectionApi } from "@takibi/api";
import type { TakibiDefinitionCarrier } from "@takibi/api";
import { compileListOptions } from "@takibi/query";
import type { ListOptions } from "@takibi/query";
import { normalizeWatchList } from "@takibi/protocol";
import type { WatchObserver } from "@takibi/api";
import { createClient, type CreateClientOptions } from "./client";
import type { ClientOf, InferHandlerCollections } from "./client-types";
import { subscribe } from "./watch-subscription";

export type CreateWatchClientOptions = CreateClientOptions & {
  /** Browser subprotocol tokens, resolved anew for every connection attempt. */
  webSocketProtocols?: () => string[] | Promise<string[]>;
};
export type WatchClientOf<H extends TakibiDefinitionCarrier> = ClientOf<H> & {
  [K in keyof InferHandlerCollections<H>]: WatchCollectionApi<InferHandlerCollections<H>[K]>;
};

/** Opt-in composition. The ordinary client entry never imports this module. */
export function createWatchClient<H extends TakibiDefinitionCarrier>(
  baseUrl: string,
  options: CreateWatchClientOptions = {},
): WatchClientOf<H> {
  const http = createClient<H>(baseUrl, options);
  const members = new Map<string, unknown>();
  return new Proxy(http as object, {
    get(target, name) {
      if (typeof name !== "string" || unsafeClientPropertyNames.has(name)) return undefined;
      if (members.has(name)) return members.get(name);
      const member = Reflect.get(target, name) as object;
      const watch = (opts: ListOptions, observer: WatchObserver<unknown>) => {
        if (!opts || typeof opts !== "object" || "cursor" in opts)
          throw new TypeError("Watch does not support cursor");
        if (
          !observer ||
          typeof observer.next !== "function" ||
          (observer.state !== undefined && typeof observer.state !== "function")
        )
          throw new TypeError("Invalid watch observer");
        for (const key of Object.keys(opts))
          if (!["where", "limit", "index", "orderBy"].includes(key))
            throw new TypeError(`Unknown watch option: ${key}`);
        const list = normalizeWatchList(compileListOptions(opts) ?? {});
        const url = new URL(`${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`);
        if (url.protocol !== "https:" && url.protocol !== "http:")
          throw new TypeError("Watch requires an HTTP(S) base URL");
        if (url.username || url.password)
          throw new TypeError("Watch URL cannot contain credentials");
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        for (const [key, value] of Object.entries(list))
          url.searchParams.set(
            key,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
        return subscribe(url.href, observer, options.webSocketProtocols);
      };
      const composed = new Proxy(member, {
        get: (target, key) => (key === "watch" ? watch : Reflect.get(target, key)),
      });
      members.set(name, composed);
      return composed;
    },
  }) as WatchClientOf<H>;
}
export type {
  WatchOptions,
  WatchState,
  WatchClosed,
  WatchSubscription,
  WatchObserver,
} from "@takibi/api";
