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
>;
/** Require caller-supplied context through handle(), without exposing a Hono entry. */
export function createTakibi<TInput, TEnv = unknown>(options: {
  entry: "handle";
}): CreateContextFn<TInput, TEnv>;
export function createTakibi<TInput, TEnv = unknown>(options?: { entry: "handle" }) {
  if (options?.entry === "handle") {
    return <TCtx extends object, TServices = Record<never, never>>(
      config: ContextConfig<TCtx, TInput, TEnv, TServices>,
    ) => createContext(config, createInitialHttpHandler<TInput>);
  }
  return <TCtx extends object, TServices = Record<never, never>>(
    config: ContextConfig<TCtx, Record<string, never>, TEnv, TServices>,
  ) => createContext(config, createHttpHandler);
}
