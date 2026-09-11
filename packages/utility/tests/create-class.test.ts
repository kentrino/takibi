import { expect, expectTypeOf, test } from "vite-plus/test";
import { createClass, TakibiClassError, type ClassInstance } from "@takibi/utility";

type Foo = {
  bar: () => Promise<void>;
};

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

type Adder = {
  add: (left: number, right: number) => number;
};

type ConstructorArg = {
  name: string;
  unused?: number;
};

test("new is available only after every method is defined", () => {
  const incomplete = createClass<Foo>().constructor<ConstructorArg>({
    runtimeCheck: true,
  });
  const defined = incomplete.define<{ name: string }>(
    "bar",
    (ctor) => ({ name: ctor.name }),
    async () => {},
  );

  expectTypeOf(incomplete).not.toHaveProperty("new");
  expectTypeOf(incomplete).not.toHaveProperty("newWithInterceptors");
  expectTypeOf(defined.new).toBeCallableWith({ name: "takibi" });
  expectTypeOf(defined.newWithInterceptors).toBeCallableWith({ name: "takibi" }, {});
  expectTypeOf(defined.new({ name: "takibi" })).toEqualTypeOf<ClassInstance<Foo>>();
  expectTypeOf(defined.new({ name: "takibi" })).not.toHaveProperty("$intercept");
  expectTypeOf(defined.new({ name: "takibi" })).not.toHaveProperty("$replace");
});

test("newWithInterceptors wraps matching methods", async () => {
  let intercepted = 0;
  const defined = createClass<Foo>()
    .constructor<ConstructorArg>({
      runtimeCheck: true,
    })
    .define<{ name: string }>(
      "bar",
      (ctor) => {
        expectTypeOf(ctor).toEqualTypeOf<ConstructorArg>();
        return { name: ctor.name };
      },
      async (deps) => {
        expectTypeOf(deps).toEqualTypeOf<{ name: string }>();
        expect(deps).toEqual({ name: "takibi" });
      },
    );

  const instance = defined.newWithInterceptors(
    { name: "takibi", unused: 1 },
    {
      bar: (context) => {
        const { ctor, methodName, args, run } = context;
        expectTypeOf(ctor).toEqualTypeOf<ConstructorArg>();
        expectTypeOf(context).not.toHaveProperty("deps");
        expect(ctor).toEqual({ name: "takibi", unused: 1 });
        expect(methodName).toBe("bar");
        expect(args).toEqual([]);
        intercepted += 1;
        return run(...args);
      },
    },
  );

  await instance.bar();
  expect(intercepted).toBe(1);
});

test("narrows pick drops unused constructor fields for run", () => {
  type Deps = {
    a: string;
    b: number;
    c: boolean;
  };

  type Service = {
    use: () => string;
  };

  const defined = createClass<Service>()
    .constructor<Deps>({
      runtimeCheck: true,
    })
    .define(
      "use",
      ({ a, b, c }) => {
        void c;
        return { a, b };
      },
      (deps) => {
        expectTypeOf(deps).toEqualTypeOf<{ a: string; b: number }>();
        expectTypeOf(deps).not.toHaveProperty("c");
        expect(deps).toEqual({ a: "x", b: 1 });
        return `${deps.a}:${deps.b}`;
      },
    );

  expect(defined.new({ a: "x", b: 1, c: true }).use()).toBe("x:1");

  defined.newWithInterceptors(
    { a: "x", b: 1, c: true },
    {
      use: ({ ctor }) => {
        expectTypeOf(ctor).toEqualTypeOf<Deps>();
        expect(ctor.c).toBe(true);
        return `${ctor.a}:${ctor.b}`;
      },
    },
  );
});

test("method arguments reach run and a single-argument hook", () => {
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", (deps, name) => {
      expectTypeOf(deps).toEqualTypeOf<{ prefix: string }>();
      return `${deps.prefix} ${name}`;
    })
    .define("count", (deps) => deps.prefix.length);

  const instance = defined.newWithInterceptors(
    { prefix: "hi" },
    {
      greet: ({ ctor, methodName, args, run }) => {
        expectTypeOf(ctor).toEqualTypeOf<{ prefix: string }>();
        expect(ctor).toEqual({ prefix: "hi" });
        expect(methodName).toBe("greet");
        expect(args).toEqual(["ada"]);
        return run(...args);
      },
    },
  );

  expect(instance.greet("ada")).toBe("hi ada");
  expect(instance.count()).toBe(2);
  expectTypeOf(instance.greet).toEqualTypeOf<(name: string) => string>();
});

test("hook replays multi-argument methods with args", () => {
  const defined = createClass<Adder>()
    .constructor<Record<string, never>>({
      runtimeCheck: true,
    })
    .define("add", (_deps, left, right) => left + right);

  const instance = defined.newWithInterceptors(
    {},
    {
      add: ({ args, run }) => run(...args),
    },
  );

  expect(instance.add(1, 2)).toBe(3);
});

test("hook can skip run", async () => {
  let ran = 0;
  const defined = createClass<Foo>()
    .constructor<ConstructorArg>({
      runtimeCheck: true,
    })
    .define("bar", async () => {
      ran += 1;
    });

  const instance = defined.newWithInterceptors(
    { name: "takibi" },
    {
      bar: async () => {},
    },
  );

  await instance.bar();
  expect(ran).toBe(0);
});

test("newWithInterceptors merges layers and wraps the previous hook via next", () => {
  const order: string[] = [];
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", (deps, name) => `${deps.prefix} ${name}`)
    .define("count", (deps) => deps.prefix.length);

  const instance = defined.newWithInterceptors(
    { prefix: "hi" },
    {
      greet: ({ args, next }) => {
        order.push("class");
        return `class ${next(...args)}`;
      },
      count: () => 99,
    },
    {
      greet: ({ args, next }) => {
        order.push("otel");
        return `otel ${next(...args)}`;
      },
    },
  );

  expect(instance.greet("ada")).toBe("otel class hi ada");
  expect(order).toEqual(["otel", "class"]);
  expect(instance.count()).toBe(99);
});

test("a later layer that calls run skips earlier layers", () => {
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", (deps, name) => `${deps.prefix} ${name}`)
    .define("count", (deps) => deps.prefix.length);

  const instance = defined.newWithInterceptors(
    { prefix: "hi" },
    {
      greet: ({ args, next }) => `class ${next(...args)}`,
    },
    {
      greet: ({ args, run }) => `raw ${run(...args)}`,
    },
  );

  expect(instance.greet("ada")).toBe("raw hi ada");
});

test("runtimeCheck wraps a failing narrows with the method name", () => {
  const defined = createClass<Foo>()
    .constructor<ConstructorArg>({
      runtimeCheck: true,
    })
    .define<{ name: string }>(
      "bar",
      (ctor) => {
        if (typeof ctor.name !== "string") {
          throw new Error("name is required");
        }
        return { name: ctor.name };
      },
      async (deps) => {
        void deps.name;
      },
    );

  expect(() => defined.new({ name: undefined as unknown as string })).toThrowError(
    TakibiClassError,
  );
  expect(() => defined.new({ name: undefined as unknown as string })).toThrowError(
    'narrows failed for "bar"',
  );
});

test("define rejects leftover or unknown method names", () => {
  const incomplete = createClass<Pair>().constructor<{ prefix: string }>({
    runtimeCheck: false,
  });
  const greet = incomplete.define("greet", (deps, name) => `${deps.prefix} ${name}`);
  expectTypeOf(greet).not.toHaveProperty("new");
  expectTypeOf(greet).not.toHaveProperty("newWithInterceptors");

  const defined = greet.define("count", (deps) => deps.prefix.length);
  expectTypeOf(defined).toHaveProperty("new");
  expectTypeOf(defined).toHaveProperty("newWithInterceptors");

  // @ts-expect-error unknown method
  incomplete.define("missing", () => undefined);

  // @ts-expect-error already defined
  greet.define("greet", (deps) => deps.prefix.length);
});

test("identity define cannot substitute constructor dependencies", () => {
  const incomplete = createClass<Pair>().constructor<{ prefix: string }>({
    runtimeCheck: true,
  });

  // @ts-expect-error identity define receives the constructor value
  incomplete.define<{ count: number }>("greet", (deps, name) => `${deps.count}:${name}`);

  const defined = incomplete
    .define<{ count: number }>(
      "greet",
      (ctor) => ({ count: ctor.prefix.length }),
      (deps, name) => `${deps.count}:${name}`,
    )
    .define("count", (deps) => deps.prefix.length);

  expect(defined.new({ prefix: "hi" }).greet("ada")).toBe("2:ada");
});

test("prototype method names are not treated as interceptors", () => {
  type ProtoSurface = {
    constructor: () => string;
    toString: () => string;
    valueOf: () => number;
  };

  const defined = createClass<ProtoSurface>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("constructor", (deps) => `${deps.prefix} ctor`)
    .define("toString", (deps) => `${deps.prefix} string`)
    .define("valueOf", (deps) => deps.prefix.length);

  const instance = defined.new({ prefix: "hi" });
  expect(instance.constructor()).toBe("hi ctor");
  expect(instance.toString()).toBe("hi string");
  expect(instance.valueOf()).toBe(2);
});

test("newWithInterceptors accepts only a partial of the method surface", () => {
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", (deps, name) => `${deps.prefix} ${name}`)
    .define("count", (deps) => deps.prefix.length);

  const instance = defined.newWithInterceptors(
    { prefix: "hi" },
    {
      greet: ({ args, run }) => `class ${run(...args)}`,
      count: ({ args, run }) => run(...args) + 10,
    },
  );

  expect(instance.greet("ada")).toBe("class hi ada");
  expect(instance.count()).toBe(12);

  defined.newWithInterceptors(
    { prefix: "hi" },
    {
      // @ts-expect-error unknown method
      missing: () => undefined,
    },
  );
});
