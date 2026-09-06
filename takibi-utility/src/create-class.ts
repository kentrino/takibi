import type { Narrows } from "./narrows";

export type AnyMethod = (...args: never[]) => unknown;

export type MethodMap = Record<string, AnyMethod>;

export type ClassConstructorOptions<TRuntimeCheck extends boolean = boolean> = {
  readonly runtimeCheck: TRuntimeCheck;
};

export type HookContext<TCtor, K extends PropertyKey, M extends AnyMethod> = {
  readonly ctor: TCtor;
  readonly deps: unknown;
  readonly methodName: K;
  readonly args: Parameters<M>;
  readonly run: (...args: Parameters<M>) => ReturnType<M>;
  readonly next: (...args: Parameters<M>) => ReturnType<M>;
};

export type HookMap<T extends MethodMap, TCtor> = {
  [K in keyof T]: (context: HookContext<TCtor, K, T[K]>) => ReturnType<T[K]>;
};

export type HookRegistration<T extends MethodMap, TCtor> = {
  registerHooks: (hooks: Partial<HookMap<T, TCtor>>) => void;
  replaceHooks: (hooks: Partial<HookMap<T, TCtor>>) => void;
};

export type ClassInstance<T extends MethodMap, TCtor> = T & HookRegistration<T, TCtor>;

export type DefineSpec<TCtor, TDeps, M extends AnyMethod> = {
  readonly narrows: Narrows<TCtor, TDeps>;
  readonly run: (deps: TDeps, ...args: Parameters<M>) => ReturnType<M>;
};

export type DefineNarrowed<TCtor, TDeps, M extends AnyMethod> = {
  run(run: (deps: TDeps, ...args: Parameters<M>) => ReturnType<M>): DefineSpec<TCtor, TDeps, M>;
};

export type BoundNarrows<TCtor, M extends AnyMethod> = {
  <TDeps>(apply: (ctor: TCtor) => TDeps): DefineNarrowed<TCtor, TDeps, M>;
  <TDeps>(): DefineNarrowed<TCtor, TDeps, M>;
};

export type DefineHelpers<TCtor, M extends AnyMethod> = {
  readonly narrows: BoundNarrows<TCtor, M>;
};

export type DefinedMethodSpec<TCtor, M extends AnyMethod> = {
  readonly narrows: Narrows<TCtor, unknown>;
  readonly run: (deps: never, ...args: Parameters<M>) => ReturnType<M>;
};

export type DefineFactory<TCtor, M extends AnyMethod> = (
  helpers: DefineHelpers<TCtor, M>,
) => DefinedMethodSpec<TCtor, M>;

type DefinedClass<T extends MethodMap, TCtor, TRuntimeCheck extends boolean> = {
  new: (ctor: TCtor) => ClassInstance<T, TCtor>;
  registerHooks: (
    hooks: Partial<HookMap<T, TCtor>>,
  ) => ClassBuilder<T, TCtor, never, TRuntimeCheck>;
  replaceHooks: (hooks: Partial<HookMap<T, TCtor>>) => ClassBuilder<T, TCtor, never, TRuntimeCheck>;
};

export type ClassBuilder<
  T extends MethodMap,
  TCtor,
  TRemaining extends keyof T,
  TRuntimeCheck extends boolean,
> = {
  define<K extends TRemaining>(
    name: K,
    spec: DefineFactory<TCtor, T[K]>,
  ): ClassBuilder<T, TCtor, Exclude<TRemaining, K>, TRuntimeCheck>;
} & ([TRemaining] extends [never] ? DefinedClass<T, TCtor, TRuntimeCheck> : {});

export type ClassFactory<T extends MethodMap> = {
  constructor: {
    <TCtor>(options: ClassConstructorOptions<true>): ClassBuilder<T, TCtor, keyof T, true>;
    <TCtor>(options: ClassConstructorOptions<false>): ClassBuilder<T, TCtor, keyof T, false>;
    <TCtor>(options: ClassConstructorOptions): ClassBuilder<T, TCtor, keyof T, boolean>;
  };
};

export class TakibiClassError extends Error {
  override readonly name = "TakibiClassError";
}

type RuntimeSpec = {
  readonly narrows: Narrows<unknown, unknown>;
  readonly run: (deps: unknown, ...args: unknown[]) => unknown;
};

type RuntimeDefineFactory = (helpers: DefineHelpers<unknown, AnyMethod>) => RuntimeSpec;

function boundNarrows<TCtor, TDeps, M extends AnyMethod>(
  apply?: (ctor: TCtor) => TDeps,
): DefineNarrowed<TCtor, TDeps, M> {
  const narrowed: Narrows<TCtor, TDeps> = {
    apply: apply ?? ((ctor) => ctor as unknown as TDeps),
  };
  return {
    run: (run) => ({ narrows: narrowed, run }),
  };
}

type RuntimeHook = (context: {
  ctor: unknown;
  deps: unknown;
  methodName: PropertyKey;
  args: unknown[];
  run: (...args: unknown[]) => unknown;
  next: (...args: unknown[]) => unknown;
}) => unknown;

type RuntimeHooks = Record<string, RuntimeHook>;

function createHookTable(from?: RuntimeHooks): RuntimeHooks {
  return Object.assign(Object.create(null), from) as RuntimeHooks;
}

function replayArgs(contextArgs: unknown[], override: unknown[]): unknown[] {
  return override.length === 0 ? contextArgs : override;
}

function composeHook(outer: RuntimeHook, inner: RuntimeHook | undefined): RuntimeHook {
  return (context) =>
    outer({
      ...context,
      next: (...override: unknown[]) => {
        const args = replayArgs(context.args, override);
        if (inner === undefined) {
          return context.run(...args);
        }
        return inner({
          ctor: context.ctor,
          deps: context.deps,
          methodName: context.methodName,
          args,
          run: context.run,
          next: (...innerOverride: unknown[]) => context.run(...replayArgs(args, innerOverride)),
        });
      },
    });
}

function mergeHooks(target: RuntimeHooks, incoming: RuntimeHooks): void {
  for (const key of Object.keys(incoming)) {
    const hook = incoming[key];
    if (typeof hook !== "function") {
      continue;
    }
    target[key] = composeHook(hook, Object.hasOwn(target, key) ? target[key] : undefined);
  }
}

function replaceHookTable(target: RuntimeHooks, incoming: RuntimeHooks): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  mergeHooks(target, incoming);
}

function createBuilder(
  options: ClassConstructorOptions,
  definitions: ReadonlyMap<string, RuntimeSpec>,
  hooks: RuntimeHooks,
) {
  return {
    define(name: string, spec: RuntimeDefineFactory) {
      const next = new Map(definitions);
      next.set(name, spec({ narrows: boundNarrows }));
      return createBuilder(options, next, createHookTable(hooks));
    },
    registerHooks(nextHooks: RuntimeHooks) {
      mergeHooks(hooks, nextHooks);
      return this;
    },
    replaceHooks(nextHooks: RuntimeHooks) {
      replaceHookTable(hooks, nextHooks);
      return this;
    },
    new(ctor: unknown) {
      const instanceHooks = createHookTable(hooks);
      const instance = Object.create(null) as Record<string, (...args: unknown[]) => unknown> & {
        registerHooks: (nextHooks: RuntimeHooks) => void;
        replaceHooks: (nextHooks: RuntimeHooks) => void;
      };

      for (const [name, spec] of definitions) {
        let deps: unknown;
        try {
          deps = spec.narrows.apply(ctor);
        } catch (error) {
          if (options.runtimeCheck) {
            throw new TakibiClassError(`narrows failed for "${name}"`, { cause: error });
          }
          throw error;
        }

        instance[name] = (...args: unknown[]) => {
          const run = (...methodArgs: unknown[]) => spec.run(deps, ...methodArgs);
          if (!Object.hasOwn(instanceHooks, name)) {
            return run(...args);
          }
          return instanceHooks[name]({
            ctor,
            deps,
            methodName: name,
            args,
            run,
            next: (...override: unknown[]) => run(...replayArgs(args, override)),
          });
        };
      }

      instance.registerHooks = (nextHooks) => {
        mergeHooks(instanceHooks, nextHooks);
      };
      instance.replaceHooks = (nextHooks) => {
        replaceHookTable(instanceHooks, nextHooks);
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
