import { bench, describe } from "vite-plus/test";
import { createClass } from "../src/index";

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

type ConstructorArg = {
  prefix: string;
};

const arg: ConstructorArg = { prefix: "hi" };

class NativePair {
  constructor(readonly arg: ConstructorArg) {}

  greet(name: string): string {
    return `${this.arg.prefix} ${name}`;
  }

  count(): number {
    return this.arg.prefix.length;
  }
}

type PairHooks = {
  greet: (context: {
    constructorArg: ConstructorArg;
    methodName: "greet";
    arg: string;
    run: (name: string) => string;
  }) => string;
  count: (context: {
    constructorArg: ConstructorArg;
    methodName: "count";
    arg: undefined;
    run: () => number;
  }) => number;
};

class HookedNativePair {
  #hooks: Partial<PairHooks> = {};

  constructor(readonly arg: ConstructorArg) {}

  registerHooks(hooks: Partial<PairHooks>): void {
    this.#hooks = hooks;
  }

  greet(name: string): string {
    const run = (value: string) => `${this.arg.prefix} ${value}`;
    const hook = this.#hooks.greet;
    if (typeof hook !== "function") {
      return run(name);
    }
    return hook({
      constructorArg: this.arg,
      methodName: "greet",
      arg: name,
      run,
    });
  }

  count(): number {
    const run = () => this.arg.prefix.length;
    const hook = this.#hooks.count;
    if (typeof hook !== "function") {
      return run();
    }
    return hook({
      constructorArg: this.arg,
      methodName: "count",
      arg: undefined,
      run,
    });
  }
}

const defined = createClass<Pair>()
  .constructor<ConstructorArg>({
    runtimeCheck: false,
  })
  .define("greet", ({ narrows }) =>
    narrows<ConstructorArg>().run((value, name) => `${value.prefix} ${name}`),
  )
  .define("count", ({ narrows }) => narrows<ConstructorArg>().run((value) => value.prefix.length));

const definedWithCheck = createClass<Pair>()
  .constructor<ConstructorArg>({
    runtimeCheck: true,
  })
  .define("greet", ({ narrows }) =>
    narrows<ConstructorArg>().run((value, name) => `${value.prefix} ${name}`),
  )
  .define("count", ({ narrows }) => narrows<ConstructorArg>().run((value) => value.prefix.length));

const passthroughHooks = {
  greet: ({ arg: name, run }: { arg: string; run: (name: string) => string }) => run(name),
  count: ({ run }: { run: () => number }) => run(),
};

const definedWithHooks = createClass<Pair>()
  .constructor<ConstructorArg>({
    runtimeCheck: false,
  })
  .define("greet", ({ narrows }) =>
    narrows<ConstructorArg>().run((value, name) => `${value.prefix} ${name}`),
  )
  .define("count", ({ narrows }) => narrows<ConstructorArg>().run((value) => value.prefix.length));
definedWithHooks.registerHooks(passthroughHooks);

const nativeInstance = new NativePair(arg);
const createClassInstance = defined.new(arg);
const hookedNativeInstance = new HookedNativePair(arg);
hookedNativeInstance.registerHooks(passthroughHooks);
const hookedCreateClassInstance = definedWithHooks.new(arg);

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
    consume(new NativePair(arg).count());
  });

  bench("createClass", () => {
    consume(defined.new(arg).count());
  });

  bench("createClass + runtimeCheck", () => {
    consume(definedWithCheck.new(arg).count());
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
