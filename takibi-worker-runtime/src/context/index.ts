import { createHttpHandler, createInitialHttpHandler } from "./http-handler";
import { createContext } from "./definition";
import type { ContextConfig, CreateContextFn } from "./types";

export type {
  CollectionsOptions,
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  HandleOptions,
  HandleResult,
  TakibiBrand,
  TakibiHandler,
} from "./types";

/** Build a Hono application whose resolver needs no initial dependencies. */
export function createTakibi<TEnv = unknown>(): CreateContextFn<
  Record<string, never>,
  TEnv,
  ReturnType<typeof createHttpHandler>
> {
  return <TCtx extends object, TServices = Record<never, never>>(
    config: ContextConfig<TCtx, Record<string, never>, TEnv, TServices>,
  ) => createContext(config, createHttpHandler);
}

/** Bind caller-supplied initial dependencies; the resulting handler has only handle(). */
function withInitial<TInitial, TEnv = unknown>(): CreateContextFn<TInitial, TEnv> {
  return <TCtx extends object, TServices = Record<never, never>>(
    config: ContextConfig<TCtx, TInitial, TEnv, TServices>,
  ) => createContext(config, createInitialHttpHandler<TInitial>);
}

createTakibi.withInitial = withInitial;
