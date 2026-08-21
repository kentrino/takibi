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
} from "./action";
import type { LoggingOptions } from "./logging";
import type { PolicyHelper } from "./policy";
import { internalTracerKey, type TakibiTracer } from "./tracing";
import type {
  CollectionDefinition,
  CollectionsApi,
  CollectionsDef,
  InferCollectionDoc,
  ReservedDocumentSchemaConstraint,
} from "./types";

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

export type ContextConfig<TCtx extends object, TInitial = Record<string, never>> = {
  resolve: ContextResolver<TCtx, TInitial>;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<TCtx, TInitial>;
} & LoggingOptions;

export type CollectionsOptions = LoggingOptions & {
  /** In-memory mode for tests / demos (skips Durable Object). */
  memory?: boolean;
};

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
> = {
  readonly "~takibi": {
    context: TCtx;
    initial: TInitial;
    collections: TCollections;
    actions: TActionMap;
  };
  DurableObject: new (
    state: DurableObjectState,
    env: unknown,
  ) => DurableObject & { $collections: CollectionsApi<TCollections> };
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
    },
  ): TakibiHandler<TCtx, TCollections, TInitial, TActionMap>;
};

export type TakibiHandler<
  TCtx extends object = Record<string, unknown>,
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TActionMap extends ActionScopeMap = Record<never, never>,
> = Hono<{ Bindings: Record<string, unknown> }> &
  TakibiBrand<TCtx, TCollections, TInitial, TActionMap>;

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
export type AppDefinition<TCtx extends object, TCollections, TInitial> = {
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
          DocumentActionArgs<TCtx, TCollections, TCollections[K]>,
          CollectionActionArgs<TCtx, TCollections, TCollections[K]>,
          InferCollectionDoc<TCollections[K]>
        >,
      ) => TActions & ActionNameConstraint<TActions>,
    ): ScopedActions<K, TActions>;
  };
} & {
  defineAction(): RootActionBuilder<TCtx, RootActionArgs<TCtx, TCollections>>;
  /**
   * Register every action map and assemble a handler. Each call returns a
   * new handler; it does not mutate a previous one. Apps without actions
   * still call `app.actions({})`.
   */
  actions<const TMap extends ActionScopeMap>(
    map: TMap & ActionsMapConstraint<TMap, TCollections>,
  ): TakibiHandler<TCtx, TCollections, TInitial, TMap>;
};

type PublicCollectionConstraint<C, TCtx extends object> = C extends {
  schema: infer S extends StandardSchemaV1;
}
  ? {
      schema: CollectionDefinition<S, TCtx>["schema"];
      accessPolicy: CollectionDefinition<S, TCtx>["accessPolicy"];
      migrations?: CollectionDefinition<S, TCtx>["migrations"];
      seed?: CollectionDefinition<S, TCtx>["seed"];
    } & ReservedDocumentSchemaConstraint<S>
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

export type CreateContextBuilder<TCtx extends object, TInitial> = {
  policy: PolicyHelper<TCtx>;
  defineCollection<
    TSchema extends StandardSchemaV1,
    const TPolicy extends CollectionDefinition<TSchema, TCtx>["accessPolicy"],
  >(
    definition: CollectionDefinitionInput<TSchema, TCtx, TPolicy> &
      ReservedDocumentSchemaConstraint<TSchema>,
  ): CollectionDefinition<TSchema, TCtx, TPolicy>;
  defineCollections<const TCollections extends PublicCollectionsMap<TCollections, TCtx>>(
    collections: TCollections & CollectionsWithMatchingDefinitions<TCollections, TCtx>,
    options?: InternalCollectionsOptions,
    ...invalidName: [
      Extract<keyof TCollections, ReservedCollectionName> | InvalidPublicKeys<TCollections>,
    ] extends [never]
      ? []
      : ["Collection names must be safe TypeScript identifiers"]
  ): AppDefinition<TCtx, TCollections, TInitial>;
};

export type CreateContextFn<TInitial> = <R extends object | Promise<object>>(config: {
  resolve: (input: ContextResolverInput<TInitial>) => R;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<Awaited<R>, TInitial>;
  logger?: LoggingOptions["logger"];
  logLevel?: LoggingOptions["logLevel"];
}) => CreateContextBuilder<Awaited<R>, TInitial>;
