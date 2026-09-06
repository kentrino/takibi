import type { Narrows } from "./narrows";

export type AnyMethod = (...args: never[]) => unknown;

export type MethodMap = Record<string, AnyMethod>;

export type ClassConstructorOptions<TRuntimeCheck extends boolean = boolean> = {
  readonly runtimeCheck: TRuntimeCheck;
};

export type MethodArgOf<M extends AnyMethod> =
  Parameters<M> extends [] ? undefined : Parameters<M> extends [infer A] ? A : Parameters<M>;

export type HookContext<TArg, K extends PropertyKey, M extends AnyMethod> = {
  readonly constructorArg: TArg;
  readonly methodName: K;
  readonly arg: MethodArgOf<M>;
  readonly run: (...args: Parameters<M>) => ReturnType<M>;
};

export type HookMap<T extends MethodMap, TArg> = {
  [K in keyof T]: (context: HookContext<TArg, K, T[K]>) => ReturnType<T[K]>;
};

export type ClassInstance<T extends MethodMap, TArg> = T & {
  registerHooks: (hooks: Partial<HookMap<T, TArg>>) => void;
};

export type DefineSpec<TArg, TNarrowed, M extends AnyMethod> = {
  readonly narrows: Narrows<TArg, TNarrowed>;
  readonly run: (arg: TNarrowed, ...args: Parameters<M>) => ReturnType<M>;
};

type DefinedClass<T extends MethodMap, TArg, TRuntimeCheck extends boolean> = {
  new: (arg: TArg) => ClassInstance<T, TArg>;
  registerHooks: (hooks: Partial<HookMap<T, TArg>>) => ClassBuilder<T, TArg, never, TRuntimeCheck>;
};

export type ClassBuilder<
  T extends MethodMap,
  TArg,
  TRemaining extends keyof T,
  TRuntimeCheck extends boolean,
> = {
  define<K extends TRemaining, TNarrowed>(
    name: K,
    spec: DefineSpec<TArg, TNarrowed, T[K]>,
  ): ClassBuilder<T, TArg, Exclude<TRemaining, K>, TRuntimeCheck>;
} & ([TRemaining] extends [never] ? DefinedClass<T, TArg, TRuntimeCheck> : {});

export type ClassFactory<T extends MethodMap> = {
  constructor: {
    <TArg>(options: ClassConstructorOptions<true>): ClassBuilder<T, TArg, keyof T, true>;
    <TArg>(options: ClassConstructorOptions<false>): ClassBuilder<T, TArg, keyof T, false>;
    <TArg>(options: ClassConstructorOptions): ClassBuilder<T, TArg, keyof T, boolean>;
  };
};

export class TakibiClassError extends Error {
  override readonly name = "TakibiClassError";
}

type RuntimeSpec = {
  readonly narrows: Narrows<unknown, unknown>;
  readonly run: (arg: unknown, ...args: unknown[]) => unknown;
};

type RuntimeHook = (context: {
  constructorArg: unknown;
  methodName: PropertyKey;
  arg: unknown;
  run: (...args: unknown[]) => unknown;
}) => unknown;

type RuntimeHooks = Record<string, RuntimeHook>;

function replaceHooks(target: RuntimeHooks, next: RuntimeHooks): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
}

function methodArg(args: unknown[]): unknown {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length === 1) {
    return args[0];
  }
  return args;
}

function createBuilder(
  options: ClassConstructorOptions,
  definitions: ReadonlyMap<string, RuntimeSpec>,
  hooks: RuntimeHooks,
) {
  return {
    define(name: string, spec: RuntimeSpec) {
      const next = new Map(definitions);
      next.set(name, spec);
      return createBuilder(options, next, { ...hooks });
    },
    registerHooks(nextHooks: RuntimeHooks) {
      replaceHooks(hooks, nextHooks);
      return this;
    },
    new(arg: unknown) {
      const instanceHooks: RuntimeHooks = { ...hooks };
      const instance = Object.create(null) as Record<string, (...args: unknown[]) => unknown> & {
        registerHooks: (nextHooks: RuntimeHooks) => void;
      };

      for (const [name, spec] of definitions) {
        let narrowed: unknown;
        try {
          narrowed = spec.narrows.apply(arg);
        } catch (error) {
          if (options.runtimeCheck) {
            throw new TakibiClassError(`narrows failed for "${name}"`, { cause: error });
          }
          throw error;
        }

        instance[name] = (...args: unknown[]) => {
          const run = (...methodArgs: unknown[]) => spec.run(narrowed, ...methodArgs);
          const hook = instanceHooks[name];
          if (typeof hook !== "function") {
            return run(...args);
          }
          return hook({
            constructorArg: arg,
            methodName: name,
            arg: methodArg(args),
            run,
          });
        };
      }

      instance.registerHooks = (nextHooks) => {
        replaceHooks(instanceHooks, nextHooks);
      };
      return instance;
    },
  };
}

export function createClass<T extends MethodMap>(): ClassFactory<T> {
  return {
    constructor: ((options: ClassConstructorOptions) =>
      createBuilder(
        options,
        new Map(),
        Object.create(null) as RuntimeHooks,
      )) as unknown as ClassFactory<T>["constructor"],
  };
}
