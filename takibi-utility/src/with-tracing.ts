export type TracingSpanKind = "internal" | "client" | "server" | "producer" | "consumer";

export type TracingSpanAttributeValue = string | number | boolean;

export type TracingSpanAttributes = Readonly<Record<string, TracingSpanAttributeValue>>;

export type TracingSpanSpec = {
  name: string;
  kind: TracingSpanKind;
  attributes?: TracingSpanAttributes;
};

export type TracingRunner = <T>(spec: TracingSpanSpec, fn: () => Promise<T>) => Promise<T>;

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
  readonly run: TracingRunner;
};

/**
 * Returns a new object with the same call surface as `instance`, wrapping one
 * async method in `run`. The original instance is left unchanged. `this` is
 * the original instance when the wrapper is used as a method.
 */
export function withTracing<T extends object, const K extends AsyncMethodKeys<T>>(
  instance: T,
  options: WithTracingOptions<T, K>,
): T {
  const original = instance[options.method];
  if (typeof original !== "function") {
    throw new TypeError(`withTracing: "${String(options.method)}" is not a function`);
  }

  const wrapper = Object.create(Object.getPrototypeOf(instance)) as T;
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(instance));

  const wrapped = function (this: unknown, ...args: MethodParams<T, K>) {
    const attributes = options.attributes?.(...args);
    const spec: TracingSpanSpec = {
      name: options.span,
      kind: options.kind ?? "internal",
      ...(attributes === undefined ? {} : { attributes }),
    };
    const receiver = this === wrapper || this == null ? instance : this;
    const invoke = () =>
      (original as (...args: MethodParams<T, K>) => Promise<unknown>).apply(receiver, args);

    return runTracedMethod(options.run, spec, invoke);
  };

  Object.defineProperty(wrapper, options.method, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapped,
  });

  return wrapper;
}

type MethodOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function runTracedMethod<T>(
  run: TracingRunner,
  spec: TracingSpanSpec,
  invoke: () => Promise<T>,
): Promise<T> {
  let outcome: MethodOutcome<T> | undefined;
  const invokeOnce = async (): Promise<T> => {
    if (outcome?.ok) return outcome.value;
    if (outcome && !outcome.ok) throw outcome.error;
    try {
      const value = await invoke();
      outcome = { ok: true, value };
      return value;
    } catch (error) {
      outcome = { ok: false, error };
      throw error;
    }
  };

  try {
    await run(spec, invokeOnce);
  } catch {
    // Tracing/logging must not replace the method result or exception.
  }

  if (outcome === undefined) {
    return invokeOnce();
  }
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
