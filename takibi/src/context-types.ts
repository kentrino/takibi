import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Hono } from "hono";
import type {
  ActionBuilder,
  ActionDefinitions,
  CollectionDefinitionInput,
  InvalidPublicKeys,
  ReservedPublicName,
  RootActionArgs,
} from "./action";
import type { LoggingOptions } from "./logging";
import type { PolicyHelper } from "./policy";
import { internalTracerKey, type TakibiTracer } from "./tracing";
import { collectionActionsBrand } from "./types";
import type {
  CollectionDefinition,
  CollectionsApi,
  CollectionsDef,
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

export type TakibiBrand<
  TCtx extends object,
  TCollections,
  TInitial = Record<string, never>,
  TRootActions extends ActionDefinitions = Record<never, never>,
> = {
  readonly "~takibi": {
    context: TCtx;
    initial: TInitial;
    collections: TCollections;
    actions: TRootActions;
  };
  DurableObject: new (
    state: DurableObjectState,
    env: unknown,
  ) => DurableObject & { $collections: CollectionsApi<TCollections> };
  defineAction(): ActionBuilder<TCtx, "root", RootActionArgs<TCtx, TCollections>>;
  actions<const TActions extends ActionDefinitions>(
    definitions: TActions &
      Record<
        | Extract<keyof TActions, keyof TCollections | keyof TRootActions | ReservedPublicName>
        | InvalidPublicKeys<TActions>,
        never
      >,
  ): TakibiHandler<TCtx, TCollections, TInitial, TRootActions & TActions>;
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
  ): TakibiHandler<TCtx, TCollections, TInitial, TRootActions>;
};

export type TakibiHandler<
  TCtx extends object = Record<string, unknown>,
  TCollections = CollectionsDef<TCtx>,
  TInitial = Record<string, never>,
  TRootActions extends ActionDefinitions = Record<never, never>,
> = Hono<{ Bindings: Record<string, unknown> }> &
  TakibiBrand<TCtx, TCollections, TInitial, TRootActions>;

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

export type CreateContextBuilder<TCtx extends object, TInitial> = {
  policy: PolicyHelper<TCtx>;
  defineCollection<
    TSchema extends StandardSchemaV1,
    const TActions extends ActionDefinitions = Record<never, never>,
  >(
    definition: CollectionDefinitionInput<TSchema, TCtx, TActions>,
  ): CollectionDefinition<TSchema, TCtx, TActions> & {
    readonly [collectionActionsBrand]: TActions;
  };
  collections<const TCollections extends PublicCollectionsMap<TCollections, TCtx>>(
    collections: TCollections & CollectionsWithMatchingDefinitions<TCollections, TCtx>,
    options?: InternalCollectionsOptions,
    ...invalidName: [
      Extract<keyof TCollections, ReservedPublicName> | InvalidPublicKeys<TCollections>,
    ] extends [never]
      ? []
      : ["Collection names must be safe TypeScript identifiers"]
  ): TakibiHandler<TCtx, TCollections, TInitial>;
};

export type CreateContextFn<TInitial> = <R extends object | Promise<object>>(config: {
  resolve: (input: ContextResolverInput<TInitial>) => R;
  /** Required for Durable Object mode (omit when using `{ memory: true }`). */
  stub?: ContextStubResolver<Awaited<R>, TInitial>;
  logger?: LoggingOptions["logger"];
  logLevel?: LoggingOptions["logLevel"];
}) => CreateContextBuilder<Awaited<R>, TInitial>;
