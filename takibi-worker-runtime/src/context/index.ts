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

/**
 * Bind initial context and environment types for the fluent definition API.
 */
export function createTakibi<TInitial = Record<string, never>, TEnv = unknown>(): CreateContextFn<
  TInitial,
  TEnv
> {
  return <TCtx extends object, TServices = Record<never, never>>(
    config: ContextConfig<TCtx, TInitial, TEnv, TServices>,
  ) => createContext(config);
}
