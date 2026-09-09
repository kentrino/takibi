import type { Narrows } from "./narrows";

export type AnyMethod = (...args: never[]) => unknown;

export type MethodMap = Record<string, AnyMethod>;

export type ClassConstructorOptions<TRuntimeCheck extends boolean = boolean> = {
  readonly runtimeCheck: TRuntimeCheck;
};

export type InterceptContext<TCtor, K extends PropertyKey, M extends AnyMethod> = {
  readonly ctor: TCtor;
  readonly methodName: K;
  readonly args: Parameters<M>;
  readonly run: (...args: Parameters<M>) => ReturnType<M>;
  readonly next: (...args: Parameters<M>) => ReturnType<M>;
};

export type InterceptMap<T extends MethodMap, TCtor> = {
  [K in keyof T]: (context: InterceptContext<TCtor, K, T[K]>) => ReturnType<T[K]>;
};

export type ClassInstance<T extends MethodMap, _TCtor = unknown> = T;

export type MethodRun<TDeps, M extends AnyMethod> = (
  deps: TDeps,
  ...args: Parameters<M>
) => ReturnType<M>;

type DefinedClass<T extends MethodMap, TCtor> = {
  new: (ctor: TCtor) => ClassInstance<T, TCtor>;
  newWithInterceptors: (
    ctor: TCtor,
    interceptors: Partial<InterceptMap<T, TCtor>>,
    ...more: Partial<InterceptMap<T, TCtor>>[]
  ) => ClassInstance<T, TCtor>;
};

type UnionToIntersection<U> = (U extends U ? (arg: U) => void : never) extends (
  arg: infer I,
) => void
  ? I
  : never;

type DefineForKey<
  T extends MethodMap,
  TCtor,
  TRemaining extends keyof T,
  TRuntimeCheck extends boolean,
  K extends TRemaining,
> = {
  (
    name: K,
    run: MethodRun<TCtor, T[K]>,
  ): ClassBuilder<T, TCtor, Exclude<TRemaining, K>, TRuntimeCheck>;
  <TDeps>(
    name: K,
    apply: (ctor: TCtor) => TDeps,
    run: MethodRun<TDeps, T[K]>,
  ): ClassBuilder<T, TCtor, Exclude<TRemaining, K>, TRuntimeCheck>;
};

type DefineFns<
  T extends MethodMap,
  TCtor,
  TRemaining extends keyof T,
  TRuntimeCheck extends boolean,
> = [TRemaining] extends [never]
  ? never
  : UnionToIntersection<
      {
        [K in TRemaining]: DefineForKey<T, TCtor, TRemaining, TRuntimeCheck, K>;
      }[TRemaining]
    >;

export type ClassBuilder<
  T extends MethodMap,
  TCtor,
  TRemaining extends keyof T,
  TRuntimeCheck extends boolean,
> = {
  define: DefineFns<T, TCtor, TRemaining, TRuntimeCheck>;
} & ([TRemaining] extends [never] ? DefinedClass<T, TCtor> : {});

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

type RuntimeInterceptor = (context: {
  ctor: unknown;
  methodName: PropertyKey;
  args: unknown[];
  run: (...args: unknown[]) => unknown;
  next: (...args: unknown[]) => unknown;
}) => unknown;

type RuntimeInterceptTable = Map<string, RuntimeInterceptor>;

function createInterceptTable(from?: RuntimeInterceptTable): RuntimeInterceptTable {
  return new Map(from);
}

function replayArgs(contextArgs: unknown[], override: unknown[]): unknown[] {
  return override.length === 0 ? contextArgs : override;
}

function composeInterceptor(
  outer: RuntimeInterceptor,
  inner: RuntimeInterceptor | undefined,
): RuntimeInterceptor {
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
          methodName: context.methodName,
          args,
          run: context.run,
          next: (...innerOverride: unknown[]) => context.run(...replayArgs(args, innerOverride)),
        });
      },
    });
}

function mergeInterceptors(target: RuntimeInterceptTable, incoming: object): void {
  for (const key of Object.keys(incoming)) {
    if (!Object.hasOwn(incoming, key)) {
      continue;
    }
    const interceptor = (incoming as Record<string, unknown>)[key];
    if (typeof interceptor !== "function") {
      continue;
    }
    target.set(key, composeInterceptor(interceptor as RuntimeInterceptor, target.get(key)));
  }
}

function createInstance(
  options: ClassConstructorOptions,
  definitions: ReadonlyMap<string, RuntimeSpec>,
  ctor: unknown,
  interceptorMaps: readonly object[],
) {
  const instanceInterceptors = createInterceptTable();
  for (const incoming of interceptorMaps) {
    mergeInterceptors(instanceInterceptors, incoming);
  }

  const instance = Object.create(null) as Record<string, (...args: unknown[]) => unknown>;

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
      const interceptor = instanceInterceptors.get(name);
      if (interceptor === undefined) {
        return run(...args);
      }
      return interceptor({
        ctor,
        methodName: name,
        args,
        run,
        next: (...override: unknown[]) => run(...replayArgs(args, override)),
      });
    };
  }

  return instance;
}

function createBuilder(
  options: ClassConstructorOptions,
  definitions: ReadonlyMap<string, RuntimeSpec>,
) {
  return {
    define(
      name: string,
      applyOrRun: (value: unknown, ...args: unknown[]) => unknown,
      maybeRun?: (deps: unknown, ...args: unknown[]) => unknown,
    ) {
      const next = new Map(definitions);
      const apply = maybeRun === undefined ? (ctor: unknown) => ctor : applyOrRun;
      const run = maybeRun ?? applyOrRun;
      next.set(name, { narrows: { apply }, run });
      return createBuilder(options, next);
    },
    new(ctor: unknown) {
      return createInstance(options, definitions, ctor, []);
    },
    newWithInterceptors(ctor: unknown, ...interceptorMaps: object[]) {
      return createInstance(options, definitions, ctor, interceptorMaps);
    },
  };
}

export function createClass<T extends MethodMap>(): ClassFactory<T> {
  return {
    constructor: ((options: ClassConstructorOptions) =>
      createBuilder(options, new Map())) as unknown as ClassFactory<T>["constructor"],
  };
}
