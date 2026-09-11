import { expect, expectTypeOf, test } from "vite-plus/test";
import { createClass, withTracing, type TracingRunner, type TracingSpanSpec } from "@takibi/utility";

type Probe = {
  target: (label: string) => Promise<string>;
  other: (label: string) => Promise<string>;
  sync: () => string;
};

class ProbeClass {
  constructor(readonly marker: string) {}

  async target(label: string): Promise<string> {
    return `${this.marker}:${label}`;
  }

  async other(label: string): Promise<string> {
    return `${this.marker}:${label}:other`;
  }

  sync(): string {
    return this.marker;
  }
}

function recordingRun(events: string[]) {
  return async <T>(spec: TracingSpanSpec, fn: () => Promise<T>): Promise<T> => {
    events.push(`start:${spec.name}:${spec.kind}`);
    if (spec.attributes !== undefined) {
      events.push(`attributes:${JSON.stringify(spec.attributes)}`);
    }
    try {
      const result = await fn();
      events.push("end");
      return result;
    } catch (error) {
      events.push(`exception:${error instanceof Error ? error.message : String(error)}`);
      events.push("end");
      throw error;
    }
  };
}

test("withTracing wraps only the named async method and keeps types", async () => {
  const instance = new ProbeClass("orig");
  const events: string[] = [];
  const wrapped = withTracing(instance, {
    method: "target",
    span: "takibi.resolve",
    kind: "internal",
    attributes: (label) => ({ label }),
    run: recordingRun(events),
  });

  type WrappedTarget = (typeof wrapped)["target"];
  type WrappedOther = (typeof wrapped)["other"];
  expectTypeOf<WrappedTarget>().toEqualTypeOf<Probe["target"]>();
  expectTypeOf<WrappedOther>().toEqualTypeOf<Probe["other"]>();
  expectTypeOf(
    withTracing(instance, { method: "target", span: "x", run: recordingRun([]) }),
  ).toEqualTypeOf<ProbeClass>();
  withTracing(instance, {
    // @ts-expect-error sync methods are not traceable
    method: "sync",
    span: "x",
    run: recordingRun([]),
  });

  expect(await wrapped.target("one")).toBe("orig:one");
  expect(await wrapped.other("two")).toBe("orig:two:other");
  expect(await instance.target("raw")).toBe("orig:raw");
  expect(events).toEqual(["start:takibi.resolve:internal", 'attributes:{"label":"one"}', "end"]);
});

test("withTracing keeps #private fields and prototype methods on the original instance", async () => {
  class PrivateProbe {
    #value = 1;
    #extra = 10;

    async target(): Promise<number> {
      this.#value += 1;
      return this.#value;
    }

    async other(): Promise<number> {
      return this.#value + this.#extra;
    }

    get shown(): number {
      return this.#value;
    }
  }

  const instance = new PrivateProbe();
  const wrapped = withTracing(instance, {
    method: "target",
    span: "span",
    run: async (_spec, fn) => fn(),
  });

  expect(await wrapped.target()).toBe(2);
  expect(await wrapped.other()).toBe(12);
  expect(wrapped.shown).toBe(2);
  expect(await instance.target()).toBe(3);
  expect(instance.shown).toBe(3);
});

test("an attributes callback failure does not skip or replace the method", async () => {
  let runs = 0;
  const instance = {
    async target() {
      runs += 1;
      return "ok";
    },
  };
  const wrapped = withTracing(instance, {
    method: "target",
    span: "s",
    attributes: () => {
      throw new Error("attributes failed");
    },
    run: async (_spec, fn) => fn(),
  });

  expect(await wrapped.target()).toBe("ok");
  expect(runs).toBe(1);
});

test("concurrent runner callbacks receive the original result with one method invocation", async () => {
  let runs = 0;
  const callbackResults: unknown[] = [];
  const instance = {
    async target() {
      runs += 1;
      await Promise.resolve();
      return "ok";
    },
  };
  const wrapped = withTracing(instance, {
    method: "target",
    span: "s",
    run: async (_spec, fn) => {
      const results = await Promise.all([fn(), fn()]);
      callbackResults.push(...results);
      return results[0];
    },
  });

  const result = await wrapped.target();

  expect(result).toBe("ok");
  expect(runs).toBe(1);
  expect(callbackResults).toEqual(["ok", "ok"]);
});

test("success, throw, and reject run the method once and keep the original outcome", async () => {
  const events: string[] = [];
  let runs = 0;
  const instance = {
    async ok() {
      runs += 1;
      return "ok";
    },
    async boom() {
      runs += 1;
      throw new Error("BOOM");
    },
    async reject() {
      runs += 1;
      return Promise.reject(new Error("REJECT"));
    },
  };

  const ok = withTracing(instance, { method: "ok", span: "s", run: recordingRun(events) });
  expect(await ok.ok()).toBe("ok");

  const boom = withTracing(instance, { method: "boom", span: "s", run: recordingRun(events) });
  await expect(boom.boom()).rejects.toThrow("BOOM");

  const reject = withTracing(instance, { method: "reject", span: "s", run: recordingRun(events) });
  await expect(reject.reject()).rejects.toThrow("REJECT");

  expect(runs).toBe(3);
  expect(events).toEqual([
    "start:s:internal",
    "end",
    "start:s:internal",
    "exception:BOOM",
    "end",
    "start:s:internal",
    "exception:REJECT",
    "end",
  ]);
});

test.each([
  {
    name: "throws before invoking the method",
    run: async () => {
      throw new Error("tracer failed");
    },
  },
  {
    name: "returns a forged result without invoking the method",
    run: async () => "forged" as never,
  },
  {
    name: "throws after invoking the method",
    run: async (_spec, fn) => {
      await fn();
      throw new Error("span end failed");
    },
  },
  {
    name: "returns a forged result before the invoked method settles",
    run: async (_spec, fn) => {
      void fn();
      return "forged" as never;
    },
  },
] satisfies Array<{ name: string; run: TracingRunner }>)(
  "preserves the result and runs once when the runner $name",
  async ({ run }) => {
    let runs = 0;
    const instance = {
      async target() {
        runs += 1;
        await Promise.resolve();
        return "ok";
      },
    };
    const wrapped = withTracing(instance, { method: "target", span: "s", run });

    const result = await wrapped.target();

    expect(result).toBe("ok");
    expect(runs).toBe(1);
  },
);

test("createClass instances keep non-target methods and ctor-bound deps", async () => {
  const defined = createClass<Probe>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("target", async (deps, label) => `${deps.prefix}:${label}`)
    .define("other", async (deps, label) => `${deps.prefix}:${label}:other`)
    .define("sync", (deps) => deps.prefix);

  const instance = defined.new({ prefix: "cls" });
  const events: string[] = [];
  const wrapped = withTracing(instance, {
    method: "target",
    span: "takibi.resolve",
    run: recordingRun(events),
  });

  expect(await wrapped.target("a")).toBe("cls:a");
  expect(await wrapped.other("b")).toBe("cls:b:other");
  expect(wrapped.sync()).toBe("cls");
  expect(await instance.target("raw")).toBe("cls:raw");
  expect(events).toEqual(["start:takibi.resolve:internal", "end"]);
});

test("writes through the wrapper update fields read by methods", async () => {
  const instance = {
    value: 1,
    async target() {
      return this.value;
    },
  };
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun([]) });
  wrapped.value = 2;
  expect(await wrapped.target()).toBe(2);
  expect(instance.value).toBe(2);
});

test("writes invoke setters with the original private-field receiver", async () => {
  class MutableProbe {
    #value = 1;
    get value() {
      return this.#value;
    }
    set value(next: number) {
      this.#value = next;
    }
    async target() {
      return this.#value;
    }
  }
  const instance = new MutableProbe();
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun([]) });
  wrapped.value = 2;
  expect(wrapped.value).toBe(2);
  expect(await wrapped.target()).toBe(2);
  expect(instance.value).toBe(2);
});

test("writes report failure for a read-only property", () => {
  const instance = {
    value: 1,
    async target() {
      return this.value;
    },
  };
  Object.defineProperty(instance, "value", { writable: false, configurable: true });
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun([]) });
  expect(Reflect.set(wrapped, "value", 2)).toBe(false);
  expect(instance.value).toBe(1);
});

test("replacing the traced method updates its implementation and keeps tracing", async () => {
  const events: string[] = [];
  const instance = {
    async target() {
      return 1;
    },
  };
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun(events) });
  wrapped.target = async () => 2;
  expect(await wrapped.target()).toBe(2);
  expect(await instance.target()).toBe(2);
  expect(events).toEqual(["start:s:internal", "end"]);
});

test("frozen own methods remain callable through the tracing wrapper", async () => {
  const events: string[] = [];
  const instance = Object.freeze({
    value: 2,
    async target() {
      return this.value;
    },
    async other() {
      return this.value + 1;
    },
  });
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun(events) });
  expect(await wrapped.target()).toBe(2);
  expect(await wrapped.other()).toBe(3);
  expect(events).toEqual(["start:s:internal", "end"]);
  expect(Reflect.set(wrapped, "value", 4)).toBe(false);
  expect(Object.keys(wrapped)).toEqual(Object.keys(instance));
  expect(Object.hasOwn(wrapped, "target")).toBe(true);
  expect("other" in wrapped).toBe(true);
  expect(Object.isFrozen(instance)).toBe(true);
});

test("a frozen instance with an own async method retains its private receiver", async () => {
  class FrozenProbe {
    #value = 7;
    target = async () => this.#value;
    other() {
      return this.#value + 1;
    }
    get shown() {
      return this.#value;
    }
  }
  const instance = Object.freeze(new FrozenProbe());
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun([]) });
  expect(await wrapped.target()).toBe(7);
  expect(wrapped.other()).toBe(8);
  expect(wrapped.shown).toBe(7);
  expect(wrapped).toBeInstanceOf(FrozenProbe);
});

test("a frozen callable instance stays callable", async () => {
  const instance = Object.freeze(
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
  const wrapped = withTracing(instance, { method: "target", span: "s", run: recordingRun([]) });
  expect(wrapped(2)).toBe(2);
  expect(Reflect.apply(wrapped, { value: 3 }, [2])).toBe(5);
  expect(await wrapped.target()).toBe("ok");
});

test("a frozen constructor stays constructible", async () => {
  class ConstructorProbe {
    constructor(readonly value: number) {}
    static async target() {
      return "ok";
    }
  }
  const wrapped = withTracing(Object.freeze(ConstructorProbe), {
    method: "target",
    span: "s",
    run: recordingRun([]),
  });
  const value = new wrapped(5);
  expect(value).toBeInstanceOf(ConstructorProbe);
  expect(value.value).toBe(5);
  expect(await wrapped.target()).toBe("ok");
});
