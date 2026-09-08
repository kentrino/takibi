import type { CollectionsDef } from "@takibi/takibi-api";
import type { StorageDriver } from "@takibi/takibi-storage";
import type { ActionScopeMap, ContextResolverInput, LoggingOptions, TakibiHandler } from "@takibi/takibi-worker-runtime";
type ServicesOption<TServices> = keyof TServices extends never ? {
    services?: TServices;
} : {
    services: TServices;
};
export type SqliteTestBackendOptions<TCtx extends object, TInitial, TServices> = LoggingOptions & {
    resolve?: (input: ContextResolverInput<TInitial>) => TCtx | Promise<TCtx>;
} & ServicesOption<TServices>;
/** Documents the layers the adapter consumes through the runtime bridge. */
export type SqliteTestBackendRuntimeLayers = {
    collections: CollectionsDef<object>;
    driver: StorageDriver;
};
export declare function withSqliteTestBackend<TCtx extends object, TCollections, TInitial, TActionMap extends ActionScopeMap, TServices, TEnv>(handler: TakibiHandler<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv>, ...[options]: keyof TServices extends never ? [options?: SqliteTestBackendOptions<TCtx, TInitial, TServices>] : [options: SqliteTestBackendOptions<TCtx, TInitial, TServices>]): TakibiHandler<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv> & {
    [Symbol.dispose](): void;
};
export {};
