import { expect, expectTypeOf, test } from "vite-plus/test";
import { registerTracingContextBackend, traced } from "@takibi/worker-runtime";
import type {
  InternalLogger,
  LogEvent,
  TakibiTracer,
  TracingContextBackend,
} from "@takibi/worker-runtime";

class Probe {
  constructor(readonly prefix: string) {}

  async first(value: number): Promise<string> {
    return `${this.prefix}:${value}`;
  }

  async second(label: string): Promise<string> {
    return `${this.prefix}:${label}:second`;
  }

  sync(): string {
    return this.prefix;
  }
}

function capture(events: LogEvent[]): InternalLogger {
  return {
    emit(event) {
      events.push(event);
    },
  };
}

test("traced infers async method arguments and instruments one method map", async () => {
  const events: LogEvent[] = [];
  const instance = new Probe("probe");
  const wrapped = traced(instance, capture(events), {
    first: {
      name: "probe.first",
      event: "takibi.action",
      attributes: ([value]) => ({ value }),
      logFields: ([value]) => ({ operation: String(value) }),
    },
    second: {
      name: "probe.second",
      event: "takibi.schema",
      logFields: ([label]) => ({ operation: label }),
    },
  });

  expectTypeOf(wrapped).toEqualTypeOf<Probe>();
  expect(await wrapped.first(1)).toBe("probe:1");
  expect(await wrapped.second("two")).toBe("probe:two:second");
  expect(wrapped.sync()).toBe("probe");
  expect(events).toEqual([
    expect.objectContaining({ event: "takibi.action", operation: "1" }),
    expect.objectContaining({ event: "takibi.schema", operation: "two" }),
  ]);
});

function rejectInvalidMethods(instance: Probe) {
  traced(instance, undefined, {
    // @ts-expect-error unknown methods are not traceable
    missing: { name: "missing", event: "takibi.action" },
  });
  traced(instance, undefined, {
    // @ts-expect-error synchronous methods are not traceable
    sync: { name: "sync", event: "takibi.action" },
  });
}
void rejectInvalidMethods;

test("traced infers async function arguments and instruments direct calls", async () => {
  const events: LogEvent[] = [];
  const fn = async (count: number, label: string): Promise<string> => `${count}:${label}`;
  const wrapped = traced(fn, capture(events), {
    name: "probe.function",
    event: "takibi.resolve",
    attributes: ([count, label]) => ({ count, label }),
    logFields: ([count, label]) => ({ operation: `${count}:${label}` }),
  });

  expectTypeOf(wrapped).toEqualTypeOf<typeof fn>();
  expect(await wrapped(2, "direct")).toBe("2:direct");
  expect(events).toEqual([
    expect.objectContaining({ event: "takibi.resolve", operation: "2:direct" }),
  ]);
});

test("instance wrapping preserves private fields, accessors, writes, and caller receivers", async () => {
  class PrivateProbe {
    #value = 1;

    get value(): number {
      return this.#value;
    }

    set value(next: number) {
      this.#value = next;
    }

    async read(label: string): Promise<string> {
      return `${label}:${this.#value}`;
    }

    other(): number {
      return this.#value + 1;
    }
  }

  const instance = new PrivateProbe();
  const wrapped = traced(instance, undefined, {
    read: { name: "probe.read", event: "takibi.action" },
  });
  wrapped.value = 4;

  expect(wrapped.value).toBe(4);
  expect(instance.value).toBe(4);
  expect(await wrapped.read("own")).toBe("own:4");
  expect(wrapped.other()).toBe(5);

  const receiverProbe = traced(
    {
      value: 1,
      async read(): Promise<number> {
        return this.value;
      },
    },
    undefined,
    { read: { name: "probe.receiver", event: "takibi.action" } },
  );
  const read = Reflect.get(receiverProbe, "read") as (this: { value: number }) => Promise<number>;
  expect(await Reflect.apply(read, { value: 9 }, [])).toBe(9);
});

test("instance wrapping preserves frozen objects, callable objects, and constructors", async () => {
  class FrozenProbe {
    #value = 7;
    target = async () => this.#value;

    other(): number {
      return this.#value + 1;
    }
  }
  const frozen = Object.freeze(new FrozenProbe());
  const wrappedFrozen = traced(frozen, undefined, {
    target: { name: "probe.target", event: "takibi.action" },
  });
  expect(await wrappedFrozen.target()).toBe(7);
  expect(wrappedFrozen.other()).toBe(8);
  expect(wrappedFrozen).toBeInstanceOf(FrozenProbe);
  expect(Object.isFrozen(frozen)).toBe(true);

  const callable = Object.freeze(
    Object.assign(
      function (this: { value: number } | void, amount: number) {
        return (this?.value ?? 0) + amount;
      },
      {
        async target() {
          return "ok";
        },
      },
    ),
  );
  const wrappedCallable = traced(callable, undefined, {
    target: { name: "probe.target", event: "takibi.action" },
  });
  expect(wrappedCallable(2)).toBe(2);
  expect(Reflect.apply(wrappedCallable, { value: 3 }, [2])).toBe(5);
  expect(await wrappedCallable.target()).toBe("ok");

  class ConstructorProbe {
    constructor(readonly value: number) {}

    static async target(): Promise<string> {
      return "ok";
    }
  }
  const WrappedConstructor = traced(Object.freeze(ConstructorProbe), undefined, {
    target: { name: "probe.target", event: "takibi.action" },
  });
  expect(new WrappedConstructor(5)).toBeInstanceOf(ConstructorProbe);
  expect(await WrappedConstructor.target()).toBe("ok");
});

test("metadata, logger, and wrapped failures preserve exactly one original outcome", async () => {
  const runs: string[] = [];
  const instance = {
    async ok(): Promise<string> {
      runs.push("ok");
      return "ok";
    },
    async boom(): Promise<never> {
      runs.push("boom");
      throw new Error("BOOM");
    },
  };
  const logger: InternalLogger = {
    emit() {
      throw new Error("logger failed");
    },
  };
  const wrapped = traced(instance, logger, {
    ok: {
      name: "probe.ok",
      event: "takibi.action",
      attributes: () => {
        throw new Error("attributes failed");
      },
      logFields: () => {
        throw new Error("fields failed");
      },
    },
    boom: { name: "probe.boom", event: "takibi.action" },
  });

  expect(await wrapped.ok()).toBe("ok");
  await expect(wrapped.boom()).rejects.toThrow("BOOM");
  expect(runs).toEqual(["ok", "boom"]);
});

test("tracer failures preserve method and function outcomes with exactly-once execution", async () => {
  let methodRuns = 0;
  let functionRuns = 0;
  const tracer: TakibiTracer = {
    startSpan() {
      throw new Error("tracer failed");
    },
    inject() {},
    extract() {
      return undefined;
    },
  };
  const backend: TracingContextBackend = {
    getStore: () => ({ tracer }),
    run: (_store, fn) => fn(),
  };
  registerTracingContextBackend(backend);
  try {
    const method = traced(
      {
        async run(): Promise<string> {
          methodRuns += 1;
          return "method";
        },
      },
      undefined,
      { run: { name: "probe.method", event: "takibi.action" } },
    );
    const fn = traced(
      async (): Promise<never> => {
        functionRuns += 1;
        throw new Error("function outcome");
      },
      undefined,
      { name: "probe.function", event: "takibi.action" },
    );

    expect(await method.run()).toBe("method");
    await expect(fn()).rejects.toThrow("function outcome");
    expect(methodRuns).toBe(1);
    expect(functionRuns).toBe(1);
  } finally {
    registerTracingContextBackend(undefined);
  }
});

test("replacing a configured method keeps it instrumented", async () => {
  const events: LogEvent[] = [];
  const instance = {
    async target(): Promise<number> {
      return 1;
    },
  };
  const wrapped = traced(instance, capture(events), {
    target: { name: "probe.target", event: "takibi.action" },
  });
  wrapped.target = async () => 2;

  expect(await wrapped.target()).toBe(2);
  expect(await instance.target()).toBe(2);
  expect(events).toHaveLength(1);
});
