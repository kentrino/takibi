import { bench, describe } from "vite-plus/test";
import { createClass } from "@takibi/utility";

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

type Ctor = {
  prefix: string;
};

const ctor: Ctor = { prefix: "hi" };

class NativePair {
  constructor(readonly ctor: Ctor) {}

  greet(name: string): string {
    return `${this.ctor.prefix} ${name}`;
  }

  count(): number {
    return this.ctor.prefix.length;
  }
}

type PairInterceptors = {
  greet: (context: {
    ctor: Ctor;
    methodName: "greet";
    args: [name: string];
    run: (name: string) => string;
  }) => string;
  count: (context: { ctor: Ctor; methodName: "count"; args: []; run: () => number }) => number;
};

class InterceptedNativePair {
  #interceptors: Partial<PairInterceptors>;

  constructor(
    readonly ctor: Ctor,
    interceptors: Partial<PairInterceptors>,
  ) {
    this.#interceptors = interceptors;
  }

  greet(name: string): string {
    const run = (value: string) => `${this.ctor.prefix} ${value}`;
    const interceptor = this.#interceptors.greet;
    if (typeof interceptor !== "function") {
      return run(name);
    }
    return interceptor({
      ctor: this.ctor,
      methodName: "greet",
      args: [name],
      run,
    });
  }

  count(): number {
    const run = () => this.ctor.prefix.length;
    const interceptor = this.#interceptors.count;
    if (typeof interceptor !== "function") {
      return run();
    }
    return interceptor({
      ctor: this.ctor,
      methodName: "count",
      args: [],
      run,
    });
  }
}

const defined = createClass<Pair>()
  .constructor<Ctor>({
    runtimeCheck: false,
  })
  .define("greet", (deps, name) => `${deps.prefix} ${name}`)
  .define("count", (deps) => deps.prefix.length);

const definedWithCheck = createClass<Pair>()
  .constructor<Ctor>({
    runtimeCheck: true,
  })
  .define("greet", (deps, name) => `${deps.prefix} ${name}`)
  .define("count", (deps) => deps.prefix.length);

const passthroughInterceptors = {
  greet: ({ args, run }: { args: [name: string]; run: (name: string) => string }) => run(...args),
  count: ({ args, run }: { args: []; run: () => number }) => run(...args),
};

const definedWithInterceptors = createClass<Pair>()
  .constructor<Ctor>({
    runtimeCheck: false,
  })
  .define("greet", (deps, name) => `${deps.prefix} ${name}`)
  .define("count", (deps) => deps.prefix.length);
const nativeInstance = new NativePair(ctor);
const createClassInstance = defined.new(ctor);
const interceptedNativeInstance = new InterceptedNativePair(ctor, passthroughInterceptors);
const interceptedCreateClassInstance = definedWithInterceptors.newWithInterceptors(
  ctor,
  passthroughInterceptors,
);

let sink = 0;

function consume(value: string | number): void {
  sink ^= typeof value === "number" ? value : value.length;
}

function callPair(instance: Pair): void {
  consume(instance.greet("ada"));
  consume(instance.count());
}

describe("construct", () => {
  bench("native class", () => {
    consume(new NativePair(ctor).count());
  });

  bench("createClass", () => {
    consume(defined.new(ctor).count());
  });

  bench("createClass + runtimeCheck", () => {
    consume(definedWithCheck.new(ctor).count());
  });
});

describe("call without interceptors", () => {
  bench("native class", () => {
    callPair(nativeInstance);
  });

  bench("createClass", () => {
    callPair(createClassInstance);
  });
});

describe("call with passthrough interceptors", () => {
  bench("native class (manual wrap)", () => {
    callPair(interceptedNativeInstance);
  });

  bench("createClass newWithInterceptors", () => {
    callPair(interceptedCreateClassInstance);
  });
});
