import { createContext } from "./definition";
import type { ContextConfig, CreateContextFn } from "./types";

export type {
  CollectionsOptions,
  ContextConfig,
  ContextResolver,
  ContextResolverInput,
  ContextStubResolver,
  ContextStubResolverInput,
  DurableObjectFetchStub,
  HandleOptions,
  HandleResult,
  TakibiBrand,
  TakibiHandler,
} from "./types";

/** Bind the caller's request context and Durable Object environment types. */
export function createTakibi<TInput = Record<string, never>, TEnv = unknown>(): CreateContextFn<
  TInput,
  TEnv
> {
  return <TCtx extends object, TServices = Record<never, never>>(
    config: ContextConfig<TCtx, TInput, TEnv, TServices>,
  ) => createContext(config);
}
