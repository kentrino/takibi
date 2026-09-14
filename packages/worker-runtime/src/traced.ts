import { withLoggedSpan, type InternalLogger, type LogEvent } from "./logging";
import type { SpanAttributes, SpanKind, SpanSpec } from "./tracing";

type AsyncFunction = (...args: never[]) => Promise<unknown>;

type AsyncMethodKeys<T> = {
  [K in keyof T]-?: T[K] extends AsyncFunction ? K : never;
}[keyof T];

type MethodArguments<T, K extends keyof T> = T[K] extends (...args: infer TArgs) => unknown
  ? TArgs
  : never;

export type TracedSpec<TArgs extends readonly unknown[]> = {
  readonly name: string;
  readonly kind?: SpanKind;
  readonly event: Exclude<LogEvent["event"], "takibi.request" | "takibi.error">;
  readonly attributes?: (args: TArgs) => SpanAttributes | undefined;
  readonly logFields?: (
    args: TArgs,
  ) => Omit<LogEvent, "level" | "message" | "event" | "durationMs">;
};

export type TracedMethodMap<T extends object> = {
  readonly [K in AsyncMethodKeys<T>]?: TracedSpec<MethodArguments<T, K>>;
};

export function traced<TFn extends (...args: never[]) => Promise<unknown>>(
  fn: TFn,
  logger: InternalLogger | undefined,
  spec: TracedSpec<Parameters<TFn>>,
): TFn;
export function traced<T extends object>(
  instance: T,
  logger: InternalLogger | undefined,
  methods: TracedMethodMap<T>,
): T;
export function traced(
  value: object,
  logger: InternalLogger | undefined,
  instrumentation: TracedSpec<readonly unknown[]> | TracedMethodMap<object>,
): object {
  if (isFunctionSpec(instrumentation)) {
    if (typeof value !== "function") {
      throw new TypeError("traced: a function spec requires a function");
    }
    return new Proxy(value, {
      apply(target, receiver, args) {
        return runInstrumented(logger, instrumentation, args, () =>
          Reflect.apply(target, receiver, args),
        );
      },
    });
  }

  return traceMethods(value, logger, instrumentation);
}

function isFunctionSpec(
  instrumentation: TracedSpec<readonly unknown[]> | TracedMethodMap<object>,
): instrumentation is TracedSpec<readonly unknown[]> {
  return (
    typeof Reflect.get(instrumentation, "name") === "string" &&
    typeof Reflect.get(instrumentation, "event") === "string"
  );
}

function traceMethods<T extends object>(
  instance: T,
  logger: InternalLogger | undefined,
  methods: TracedMethodMap<T>,
): T {
  for (const key of Reflect.ownKeys(methods)) {
    if (typeof Reflect.get(instance, key, instance) !== "function") {
      throw new TypeError(`traced: "${String(key)}" is not a function`);
    }
  }

  const callable = typeof instance === "function" ? instance : undefined;
  const facade = (
    callable
      ? Function.prototype.bind.call(callable, undefined)
      : Object.create(Object.getPrototypeOf(instance))
  ) as T;
  const proxy: T = new Proxy(facade, {
    get(_target, prop, receiver) {
      const value = Reflect.get(instance, prop, instance);
      if (typeof value !== "function") {
        return receiver === proxy ? value : Reflect.get(instance, prop, receiver);
      }
      const spec = Reflect.get(methods, prop) as TracedSpec<readonly unknown[]> | undefined;
      return function (this: unknown, ...args: readonly unknown[]) {
        const self = this === proxy || this == null ? instance : this;
        const invoke = () => Reflect.apply(value, self, args);
        return spec === undefined ? invoke() : runInstrumented(logger, spec, args, invoke);
      };
    },
    set(_target, prop, value, receiver): boolean {
      return Reflect.set(instance, prop, value, receiver === proxy ? instance : receiver);
    },
    apply(_target, receiver, args) {
      return Reflect.apply(callable!, receiver, args);
    },
    construct(_target, args, newTarget) {
      return Reflect.construct(callable!, args, newTarget === proxy ? callable! : newTarget);
    },
    has(_target, prop) {
      return Reflect.has(instance, prop);
    },
    ownKeys() {
      return Reflect.ownKeys(instance);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(instance, prop);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    preventExtensions() {
      return false;
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

async function runInstrumented<T>(
  logger: InternalLogger | undefined,
  spec: TracedSpec<readonly unknown[]>,
  args: readonly unknown[],
  invoke: () => Promise<T>,
): Promise<T> {
  let inflight: Promise<T> | undefined;
  const invokeOnce = (): Promise<T> => {
    if (inflight === undefined) {
      inflight = Promise.resolve().then(invoke);
    }
    return inflight;
  };

  let attributes: SpanAttributes | undefined;
  let logFields: Omit<LogEvent, "level" | "message" | "event" | "durationMs"> | undefined;
  try {
    attributes = spec.attributes?.(args);
  } catch {
    // Instrumentation metadata must not change the wrapped operation.
  }
  try {
    logFields = spec.logFields?.(args);
  } catch {
    // Instrumentation metadata must not change the wrapped operation.
  }

  const span: SpanSpec = {
    name: spec.name,
    kind: spec.kind ?? "internal",
    ...(attributes === undefined ? {} : { attributes }),
  };
  try {
    await withLoggedSpan(
      logger,
      span,
      {
        event: spec.event,
        ...logFields,
      },
      invokeOnce,
    );
  } catch {
    // Tracing and logging must not replace the wrapped operation's outcome.
  }

  return invokeOnce();
}
