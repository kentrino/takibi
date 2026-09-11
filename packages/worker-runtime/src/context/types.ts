import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ActionDefinitions,
  ActionNameConstraint,
  CollectionActionArgs,
  CollectionDefinition,
  CollectionDefinitionInput,
  CollectionIndexes,
  CollectionUniqueConstraints,
  CollectionsDef,
  DocumentActionArgs,
  DocumentActionBuilder,
  DurableObjectCollectionsApi,
  IndexDeclaration,
  InferCollectionDoc,
  InvalidPublicKeys,
  ReservedDocumentSchemaConstraint,
  ReservedPublicName,
  RootActionArgs,
  RootActionBuilder,
  ScopedActions,
  UniqueConstraintDeclaration,
} from "@takibi/api";
import type { PolicyHelper } from "@takibi/policy";
import type { TakibiBrandCarrier, TakibiBrandRecord } from "../brand";
import type { LoggingOptions } from "../logging";
import { internalTracerKey, type TakibiTracer } from "../tracing";

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

/** The Durable Object operation used by the Worker execution backend. */
export type DurableObjectFetchStub = Pick<DurableObject, "fetch">;

export type ContextStubResolver<TCtx extends object, TInitial = Record<string, never>> = (
  input: ContextStubResolverInput<TCtx, TInitial>,
) => DurableObjectFetchStub | Promise<DurableObjectFetchStub>;

export type ServicesFactory<TEnv, TServices> = (input: { env: TEnv }) => TServices;

export type ContextConfig<
  TCtx extends object,
  TInitial = Record<string, never>,
  TEnv = unknown,
  TServices = Record<never, never>,
> = {
  resolve: ContextResolver<TCtx, TInitial>;
  /** Resolves the tenant Durable Object used for production execution. */
  stub?: ContextStubResolver<TCtx, TInitial>;
  /** Per-instance factory for non-serializable runtime dependencies. */
  services?: ServicesFactory<TEnv, TServices>;
} & LoggingOptions;

export type CollectionsOptions = LoggingOptions;

export type InternalCollectionsOptions = CollectionsOptions & {
  [internalTracerKey]?: TakibiTracer;
};

export type HandleOptions<TInitial> = {
  /**
   * Path prefix for REST routes (e.g. `/api/takibi` matches `/api/takibi/posts`
   * and `/api/takibi/posts/{id}`, but not `/api/takibihose`). Omit to read
   * collection / id from the whole pathname.
   */
  prefix?: string;
} & { context: TInitial };

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
> = TakibiBrandCarrier<TakibiBrandRecord<TCtx, TInitial, TCollections, TActionMap, TServices>> & {
  DurableObject: new (
    state: DurableObjectState,
    env: TEnv,
  ) => DurableObject & {
    $collections: DurableObjectCollectionsApi<TCollections>;
  };
  /**
   * oRPC-style entry: pass framework deps as typed initial `context`.
   * Hono applications connect this entry with takibiServer from the Hono adapter.
   */
  handle(request: Request, options: HandleOptions<TInitial>): Promise<HandleResult>;
};

export type TakibiHandler<
  TCtx extends object = Record<string, unknown>,
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TActionMap extends ActionScopeMap = Record<never, never>,
  TServices = Record<never, never>,
  TEnv = unknown,
> = TakibiBrand<TCtx, TCollections, TInitial, TActionMap, TServices, TEnv>;

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

type PublicCollectionIndexConstraint<C, TSchema extends StandardSchemaV1> = C extends {
  indexes: infer TIndexes;
}
  ? { indexes: TIndexes & IndexDeclaration<TSchema, TIndexes> }
  : { indexes?: CollectionDefinition<TSchema>["indexes"] };

type PublicCollectionConstraint<C, TCtx extends object> = C extends {
  schema: infer S extends StandardSchemaV1;
}
  ? {
      schema: CollectionDefinition<S, TCtx>["schema"];
      accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
      migrations?: CollectionDefinition<S, TCtx>["migrations"];
      seed?: CollectionDefinition<S, TCtx>["seed"];
    } & PublicCollectionUniqueConstraint<C, S> &
      PublicCollectionIndexConstraint<C, S> &
      ReservedDocumentSchemaConstraint<S>
  : {
      schema: StandardSchemaV1;
      accessPolicy: CollectionDefinition<StandardSchemaV1, TCtx>["accessPolicy"];
    };

export type PublicCollectionsMap<TCollections, TCtx extends object> = {
  [K in keyof TCollections]: PublicCollectionConstraint<TCollections[K], TCtx>;
};

export type CollectionsWithMatchingDefinitions<TCollections, TCtx extends object> = {
  [K in keyof TCollections]: TCollections[K] extends { schema: infer S extends StandardSchemaV1 }
    ? Omit<TCollections[K], "schema" | "accessPolicy" | "migrations"> & {
        schema: CollectionDefinition<S, TCtx>["schema"];
        accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
        migrations?: CollectionDefinition<S, TCtx>["migrations"];
      } & ReservedDocumentSchemaConstraint<S>
    : TCollections[K];
};

type ReservedCollectionName =
  | ReservedPublicName
  | "defineAction"
  | "actions"
  | "$transaction"
  | "$exportSnapshot"
  | "$restoreSnapshot"
  | "$resetAll";

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
    const TIndexes extends CollectionIndexes<TSchema> | Record<string, never> = Record<
      string,
      never
    >,
  >(
    definition: CollectionDefinitionInput<TSchema, TCtx, TPolicy, TUnique, TIndexes> &
      ReservedDocumentSchemaConstraint<TSchema>,
  ): CollectionDefinition<TSchema, TCtx, TPolicy, TIndexes>;
  defineCollections<const TCollections extends PublicCollectionsMap<TCollections, TCtx>>(
    collections: TCollections & CollectionsWithMatchingDefinitions<TCollections, TCtx>,
    options?: InternalCollectionsOptions,
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
