import { createContext } from "./definition";
import type { CreateContextFn } from "./types";

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
 *
 * This is the single type boundary for the runtime-generated collection keys
 * and phantom context/services brand. Runtime construction validates names and
 * definitions; the public signature preserves schema/action inference.
 */
export function createTakibi<TInitial = Record<string, never>, TEnv = unknown>(): CreateContextFn<
  TInitial,
  TEnv
> {
  return createContext as CreateContextFn<TInitial, TEnv>;
}
