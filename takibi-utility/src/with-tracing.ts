export type TracingSpanKind = "internal" | "client" | "server" | "producer" | "consumer";

export type TracingSpanAttributeValue = string | number | boolean;

export type TracingSpanAttributes = Readonly<Record<string, TracingSpanAttributeValue>>;

export type TracingSpanSpec = {
  name: string;
  kind: TracingSpanKind;
  attributes?: TracingSpanAttributes;
};

export type TracingRunner = <T>(
  spec: TracingSpanSpec,
  fn: () => Promise<T>,
  args: readonly unknown[],
) => Promise<T>;

type AsyncMethodKeys<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => infer R
    ? [R] extends [Promise<unknown>]
      ? K
      : never
    : never;
}[keyof T];

type MethodParams<T, K extends keyof T> = T[K] extends (...args: infer A) => unknown ? A : never;

export type WithTracingOptions<T, K extends AsyncMethodKeys<T>> = {
  readonly method: K;
  readonly span: string;
  readonly kind?: TracingSpanKind;
  readonly attributes?: (...args: MethodParams<T, K>) => TracingSpanAttributes | undefined;
  readonly run: <R>(
    spec: TracingSpanSpec,
    fn: () => Promise<R>,
    args: MethodParams<T, K>,
  ) => Promise<R>;
};

/**
 * Returns a proxy with the same call surface as `instance`, wrapping one async
 * method in `run`. Construction leaves the original instance unchanged; writes
 * through the proxy update it. Method calls use
 * that instance as `this` so `#private` fields and prototype methods keep
 * working.
 */
export function withTracing<T extends object, const K extends AsyncMethodKeys<T>>(
  instance: T,
  options: WithTracingOptions<T, K>,
): T {
  if (typeof instance[options.method] !== "function") {
    throw new TypeError(`withTracing: "${String(options.method)}" is not a function`);
  }

  const wrapped = function (this: unknown, ...args: MethodParams<T, K>) {
    const original = instance[options.method];
    let attributes: TracingSpanAttributes | undefined;
    try {
      attributes = options.attributes?.(...args);
    } catch {
      // Attribute builders are instrumentation; they must not skip the method.
    }
    const spec: TracingSpanSpec = {
      name: options.span,
      kind: options.kind ?? "internal",
      ...(attributes === undefined ? {} : { attributes }),
    };
    const receiver = this === proxy || this == null ? instance : this;
    const invoke = () =>
      (original as (...args: MethodParams<T, K>) => Promise<unknown>).apply(receiver, args);
    return runTracedMethod(options.run, spec, invoke, args);
  };

  const proxy = new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === options.method) {
        return wrapped;
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") {
        return function (this: unknown, ...args: unknown[]) {
          const self = this === proxy || this == null ? target : this;
          return (value as (...methodArgs: unknown[]) => unknown).apply(self, args);
        };
      }
      return receiver === proxy ? value : Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver): boolean {
      return Reflect.set(target, prop, value, receiver === proxy ? target : receiver);
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });

  return proxy;
}

async function runTracedMethod<T, TArgs extends readonly unknown[]>(
  run: (spec: TracingSpanSpec, fn: () => Promise<T>, args: TArgs) => Promise<T>,
  spec: TracingSpanSpec,
  invoke: () => Promise<T>,
  args: TArgs,
): Promise<T> {
  let inflight: Promise<T> | undefined;
  const invokeOnce = (): Promise<T> => {
    if (inflight === undefined) {
      inflight = Promise.resolve().then(invoke);
    }
    return inflight;
  };

  try {
    await run(spec, invokeOnce, args);
  } catch {
    // Tracing/logging must not replace the method result or exception.
  }

  return invokeOnce();
}
