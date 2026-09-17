import type { ListOptions } from "@takibi/query";
import type { TakibiFailure } from "@takibi/shared-types";
import type { DistributiveOmit } from "./type-util";
import type { InferCollectionDoc, InferCollectionIndexes } from "./types";
import type { PolicyReasonCodeOf } from "@takibi/policy";

export type WatchOptions<
  TDoc,
  TIndexes extends Record<string, readonly string[]> = Record<string, never>,
> = DistributiveOmit<ListOptions<TDoc, TIndexes>, "cursor"> & { cursor?: never };
export type WatchState = "connecting" | "open" | "reconnecting";
export type WatchClosed<TCode extends string = never> =
  | { reason: "unsubscribed" }
  | { reason: "server-closed" }
  | { reason: "protocol-error"; error: Error }
  | { reason: "server-error"; error: TakibiFailure<TCode> };
export type WatchSubscription<TCode extends string = never> = {
  unsubscribe(): void;
  closed: Promise<WatchClosed<TCode>>;
};
export type WatchObserver<TDoc> = {
  next(snapshot: { items: TDoc[] }): void;
  state?(state: WatchState): void;
};
export type WatchCollectionApi<C> = {
  watch(
    options: WatchOptions<InferCollectionDoc<C>, InferCollectionIndexes<C>>,
    observer: WatchObserver<InferCollectionDoc<C>>,
  ): WatchSubscription<C extends { accessPolicy: infer P } ? PolicyReasonCodeOf<P> : never>;
};
