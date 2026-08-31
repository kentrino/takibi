import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Hono } from "hono";
import type {
  ActionDefinitions,
  ActionNameConstraint,
  CollectionActionArgs,
  CollectionDefinitionInput,
  DocumentActionArgs,
  DocumentActionBuilder,
  InvalidPublicKeys,
  ReservedPublicName,
  RootActionArgs,
  RootActionBuilder,
  ScopedActions,
} from "../action";
import type { LoggingOptions } from "../logging";
import type { PolicyHelper } from "../policy";
import { internalTracerKey, type TakibiTracer } from "../tracing";
import type {
  CollectionDefinition,
  CollectionUniqueConstraints,
  CollectionsApi,
  CollectionsDef,
  InferCollectionDoc,
  ReservedDocumentSchemaConstraint,
  UniqueConstraintDeclaration,
} from "../types";

export type ContextResolverInput<TInitial = Record<string, never>> = {
  request: Request;
  context: TInitial;
};

export type ContextResolver<TCtx extends object, TInitial = Record<string, never>> = (
  input: ContextResolverInput<TInitial>,
) => TCtx | Promise<TCtx>;

export type ContextStubResolverInput<
  TCtx extends object,
  TInitial = Record<string, never>,
> = ContextResolverInput<TInitial> & { resolved: TCtx };

export type ContextStubResolver<TCtx extends object, TInitial = Record<string, never>> = (
  input: ContextStubResolverInput<TCtx, TInitial>,
) => DurableObjectStub | Promise<DurableObjectStub>;

export type ServicesFactory<TEnv, TServices> = (input: { env: TEnv }) => TServices;

/**
 * Empty `TServices` (`Record<never, never>`) keeps `services` optional — the same
 * emptiness check as `HandleOptions.context`.
 */
export type MemoryServicesOption<TServices> =
  Record<string, never> extends TServices ? { services?: TServices } : { services: TServices };

export type ContextConfig<
  TCtx extends object,
  TInitial = Record<string, never>,
  TEnv = unknown,
  TServices = Record<never, never>,
> = {
  resolve: ContextResolver<TCtx, TInitial>;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<TCtx, TInitial>;
  /**
   * Per-instance factory for non-serializable runtime deps. Runs in the Durable
   * Object constructor with `{ env }`. Memory mode takes the value, not this factory.
   */
  services?: ServicesFactory<TEnv, TServices>;
} & LoggingOptions;

export type CollectionsOptions<TServices = Record<never, never>> = LoggingOptions &
  ({ memory?: false } | ({ memory: true } & MemoryServicesOption<TServices>));

export type InternalCollectionsOptions<TServices = Record<never, never>> =
  CollectionsOptions<TServices> & {
    [internalTracerKey]?: TakibiTracer;
  };

export type HandleOptions<TInitial> = {
  /**
   * Path prefix for REST routes (e.g. `/api/takibi` matches `/api/takibi/posts`
   * and `/api/takibi/posts/{id}`, but not `/api/takibihose`). Omit to read
   * collection / id from the whole pathname.
   */
  prefix?: string;
} & (Record<string, never> extends TInitial ? { context?: TInitial } : { context: TInitial });

export type HandleResult =
  | { matched: true; response: Response }
  | { matched: false; response?: undefined };

/**
 * Actions registered on `app.actions({ ... })`, keyed by wire scope:
 * `$` for root actions, a collection name for its collection actions.
 */
export type ActionScopeMap = {
  [scope: string]: ActionDefinitions;
};

export type TakibiBrand<
  TCtx extends object,
  TCollections,
  TInitial = Record<string, never>,
  TActionMap extends ActionScopeMap = Record<never, never>,
  TServices = Record<never, never>,
  TEnv = unknown,
> = {
  readonly "~takibi": {
    context: TCtx;
    initial: TInitial;
    collections: TCollections;
    actions: TActionMap;
  };
  DurableObject: new (
    state: DurableObjectState,
    env: TEnv,
  ) => DurableObject & {
    $collections: CollectionsApi<TCollections>;
    $resetStorage(): Promise<void>;
  };
  /**
   * oRPC-style entry: pass framework deps as typed initial `context`.
   * Prefer this over `app.route` when AuthN needs DI / request-scoped services.
   */
  handle(request: Request, options: HandleOptions<TInitial>): Promise<HandleResult>;
  /**
   * Fork a handler for tests: same collections / actions, new memory store,
   * optional `resolve` override. The original handler is unchanged.
   */
  with(
    options: LoggingOptions & {
      memory: true;
      resolve?: (input: ContextResolverInput<TInitial>) => TCtx | Promise<TCtx>;
    } & MemoryServicesOption<TServices>,
  ): TakibiHandler<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv>;
};

export type TakibiHandler<
  TCtx extends object = Record<string, unknown>,
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TActionMap extends ActionScopeMap = Record<never, never>,
  TServices = Record<never, never>,
  TEnv = unknown,
> = Hono<{ Bindings: Record<string, unknown> }> &
  TakibiBrand<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv>;

type RootActionsConstraint<TActions, TCollections> = Record<
  Extract<keyof TActions, keyof TCollections | ReservedPublicName> | InvalidPublicKeys<TActions>,
  never
>;

type ActionsMapConstraint<TMap, TCollections> = {
  [K in keyof TMap]: K extends "$"
    ? ActionDefinitions & RootActionsConstraint<TMap[K], TCollections>
    : K extends keyof TCollections & string
      ? ScopedActions<K, ActionDefinitions>
      : never;
};

/**
 * Definition surface returned by `defineCollections()`. Define actions on it
 * (`app.<collection>.actions(cb)` / `app.defineAction()`), then obtain the
 * handler with a single `app.actions({ ... })` call.
 */
export type AppDefinition<
  TCtx extends object,
  TCollections,
  TInitial,
  TServices = Record<never, never>,
  TEnv = unknown,
> = {
  [K in keyof TCollections & string]: {
    /**
     * Define this collection's actions. `defineAction()` starts a document
     * action (client: `(id, input?)`); call `.detached()` for actions that
     * are not bound to one existing document.
     */
    actions<const TActions extends ActionDefinitions>(
      define: (
        defineAction: () => DocumentActionBuilder<
          TCtx,
          DocumentActionArgs<TCtx, TCollections, TCollections[K], TServices>,
          CollectionActionArgs<TCtx, TCollections, TCollections[K], TServices>,
          InferCollectionDoc<TCollections[K]>
        >,
      ) => TActions & ActionNameConstraint<TActions>,
    ): ScopedActions<K, TActions>;
  };
} & {
  defineAction(): RootActionBuilder<TCtx, RootActionArgs<TCtx, TCollections, TServices>>;
  /**
   * Register every action map and assemble a handler. Each call returns a
   * new handler; it does not mutate a previous one. Apps without actions
   * still call `app.actions({})`.
   */
  actions<const TMap extends ActionScopeMap>(
    map: TMap & ActionsMapConstraint<TMap, TCollections>,
  ): TakibiHandler<TCtx, TCollections, TInitial, TMap, TServices, TEnv>;
};

type PublicCollectionUniqueConstraint<C, TSchema extends StandardSchemaV1> = C extends {
  unique: infer TUnique;
}
  ? { unique: TUnique & UniqueConstraintDeclaration<TSchema, TUnique> }
  : { unique?: CollectionDefinition<TSchema>["unique"] };

type PublicCollectionConstraint<C, TCtx extends object> = C extends {
  schema: infer S extends StandardSchemaV1;
}
  ? {
      schema: CollectionDefinition<S, TCtx>["schema"];
      accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
      migrations?: CollectionDefinition<S, TCtx>["migrations"];
      seed?: CollectionDefinition<S, TCtx>["seed"];
    } & PublicCollectionUniqueConstraint<C, S> &
      ReservedDocumentSchemaConstraint<S>
  : {
      schema: StandardSchemaV1;
      accessPolicy: CollectionDefinition<StandardSchemaV1, TCtx>["accessPolicy"];
    };

type PublicCollectionsMap<TCollections, TCtx extends object> = {
  [K in keyof TCollections]: PublicCollectionConstraint<TCollections[K], TCtx>;
};

type CollectionsWithMatchingDefinitions<TCollections, TCtx extends object> = {
  [K in keyof TCollections]: TCollections[K] extends { schema: infer S extends StandardSchemaV1 }
    ? Omit<TCollections[K], "schema" | "accessPolicy" | "migrations"> & {
        schema: CollectionDefinition<S, TCtx>["schema"];
        accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
        migrations?: CollectionDefinition<S, TCtx>["migrations"];
      } & ReservedDocumentSchemaConstraint<S>
    : TCollections[K];
};

type ReservedCollectionName = ReservedPublicName | "defineAction" | "actions";

export type CreateContextBuilder<
  TCtx extends object,
  TInitial,
  TServices = Record<never, never>,
  TEnv = unknown,
> = {
  policy: PolicyHelper<TCtx>;
  defineCollection<
    TSchema extends StandardSchemaV1,
    const TPolicy extends CollectionDefinition<TSchema, TCtx>["accessPolicy"],
    const TUnique extends CollectionUniqueConstraints<TSchema> =
      CollectionUniqueConstraints<TSchema>,
  >(
    definition: CollectionDefinitionInput<TSchema, TCtx, TPolicy, TUnique> &
      ReservedDocumentSchemaConstraint<TSchema>,
  ): CollectionDefinition<TSchema, TCtx, TPolicy>;
  defineCollections<const TCollections extends PublicCollectionsMap<TCollections, TCtx>>(
    collections: TCollections & CollectionsWithMatchingDefinitions<TCollections, TCtx>,
    options?: InternalCollectionsOptions<TServices>,
    ...invalidName: [
      Extract<keyof TCollections, ReservedCollectionName> | InvalidPublicKeys<TCollections>,
    ] extends [never]
      ? []
      : ["Collection names must be safe TypeScript identifiers"]
  ): AppDefinition<TCtx, TCollections, TInitial, TServices, TEnv>;
};

export type CreateContextFn<TInitial, TEnv = unknown> = {
  <R extends object | Promise<object>, TServices>(config: {
    resolve: (input: ContextResolverInput<TInitial>) => R;
    stub?: ContextStubResolver<Awaited<R>, TInitial>;
    services: ServicesFactory<TEnv, TServices>;
    logger?: LoggingOptions["logger"];
    logLevel?: LoggingOptions["logLevel"];
  }): CreateContextBuilder<Awaited<R>, TInitial, TServices, TEnv>;
  <R extends object | Promise<object>>(config: {
    resolve: (input: ContextResolverInput<TInitial>) => R;
    stub?: ContextStubResolver<Awaited<R>, TInitial>;
    logger?: LoggingOptions["logger"];
    logLevel?: LoggingOptions["logLevel"];
  }): CreateContextBuilder<Awaited<R>, TInitial, Record<never, never>, TEnv>;
};
