import { expect, expectTypeOf, test } from "vite-plus/test";
import { createClass, withTracing, type TracingSpanSpec } from "../src/index";

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
  expect(instance.target === wrapped.target).toBe(false);
  expect(await instance.target("raw")).toBe("orig:raw");
  expect(events).toEqual(["start:takibi.resolve:internal", 'attributes:{"label":"one"}', "end"]);
});

test("withTracing preserves this for the original instance", async () => {
  const instance = new ProbeClass("self");
  const wrapped = withTracing(instance, {
    method: "target",
    span: "span",
    run: async (_spec, fn) => fn(),
  });

  expect(await wrapped.target("x")).toBe("self:x");
  expect(await wrapped.other("y")).toBe("self:y:other");
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

test("a failing or silent runner does not replace the method result or re-run it", async () => {
  let runs = 0;
  const instance = {
    async target() {
      runs += 1;
      return "ok";
    },
  };

  const throwing = withTracing(instance, {
    method: "target",
    span: "s",
    run: async () => {
      throw new Error("tracer failed");
    },
  });
  expect(await throwing.target()).toBe("ok");
  expect(runs).toBe(1);

  const silent = withTracing(instance, {
    method: "target",
    span: "s",
    run: async () => "forged" as never,
  });
  expect(await silent.target()).toBe("ok");
  expect(runs).toBe(2);

  const afterInvoke = withTracing(instance, {
    method: "target",
    span: "s",
    run: async (_spec, fn) => {
      await fn();
      throw new Error("span end failed");
    },
  });
  expect(await afterInvoke.target()).toBe("ok");
  expect(runs).toBe(3);
});

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
