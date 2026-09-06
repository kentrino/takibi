import { bench, describe } from "vite-plus/test";
import { createClass } from "../src/index";

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

type PairHooks = {
  greet: (context: {
    ctor: Ctor;
    deps: unknown;
    methodName: "greet";
    args: [name: string];
    run: (name: string) => string;
  }) => string;
  count: (context: {
    ctor: Ctor;
    deps: unknown;
    methodName: "count";
    args: [];
    run: () => number;
  }) => number;
};

class HookedNativePair {
  #hooks: Partial<PairHooks> = {};

  constructor(readonly ctor: Ctor) {}

  registerHooks(hooks: Partial<PairHooks>): void {
    this.#hooks = hooks;
  }

  greet(name: string): string {
    const run = (value: string) => `${this.ctor.prefix} ${value}`;
    const hook = this.#hooks.greet;
    if (typeof hook !== "function") {
      return run(name);
    }
    return hook({
      ctor: this.ctor,
      deps: this.ctor,
      methodName: "greet",
      args: [name],
      run,
    });
  }

  count(): number {
    const run = () => this.ctor.prefix.length;
    const hook = this.#hooks.count;
    if (typeof hook !== "function") {
      return run();
    }
    return hook({
      ctor: this.ctor,
      deps: this.ctor,
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
  .define("greet", ({ narrows }) => narrows<Ctor>().run((deps, name) => `${deps.prefix} ${name}`))
  .define("count", ({ narrows }) => narrows<Ctor>().run((deps) => deps.prefix.length));

const definedWithCheck = createClass<Pair>()
  .constructor<Ctor>({
    runtimeCheck: true,
  })
  .define("greet", ({ narrows }) => narrows<Ctor>().run((deps, name) => `${deps.prefix} ${name}`))
  .define("count", ({ narrows }) => narrows<Ctor>().run((deps) => deps.prefix.length));

const passthroughHooks = {
  greet: ({ args, run }: { args: [name: string]; run: (name: string) => string }) => run(...args),
  count: ({ args, run }: { args: []; run: () => number }) => run(...args),
};

const definedWithHooks = createClass<Pair>()
  .constructor<Ctor>({
    runtimeCheck: false,
  })
  .define("greet", ({ narrows }) => narrows<Ctor>().run((deps, name) => `${deps.prefix} ${name}`))
  .define("count", ({ narrows }) => narrows<Ctor>().run((deps) => deps.prefix.length));
definedWithHooks.registerHooks(passthroughHooks);

const nativeInstance = new NativePair(ctor);
const createClassInstance = defined.new(ctor);
const hookedNativeInstance = new HookedNativePair(ctor);
hookedNativeInstance.registerHooks(passthroughHooks);
const hookedCreateClassInstance = definedWithHooks.new(ctor);

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

describe("call without hooks", () => {
  bench("native class", () => {
    callPair(nativeInstance);
  });

  bench("createClass", () => {
    callPair(createClassInstance);
  });
});

describe("call with passthrough hooks", () => {
  bench("native class (manual wrap)", () => {
    callPair(hookedNativeInstance);
  });

  bench("createClass registerHooks", () => {
    callPair(hookedCreateClassInstance);
  });
});
