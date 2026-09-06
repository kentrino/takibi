import { expect, expectTypeOf, test } from "vite-plus/test";
import { createClass, TakibiClassError, type ClassInstance } from "../src/index";

type Foo = {
  bar: () => Promise<void>;
};

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

type ConstructorArg = {
  name: string;
  unused?: number;
};

test("new is available only after every method is defined", () => {
  const incomplete = createClass<Foo>().constructor<ConstructorArg>({
    runtimeCheck: true,
  });
  const defined = incomplete.define("bar", ({ narrows }) =>
    narrows<{ name: string }>((arg) => ({ name: arg.name })).run(async () => {}),
  );

  expectTypeOf(incomplete).not.toHaveProperty("new");
  expectTypeOf(incomplete).not.toHaveProperty("registerHooks");
  expectTypeOf(defined.new).toBeCallableWith({ name: "takibi" });
  expectTypeOf(defined.new({ name: "takibi" })).toEqualTypeOf<ClassInstance<Foo, ConstructorArg>>();
});

test("class registerHooks wraps matching methods", async () => {
  let hooked = 0;
  const defined = createClass<Foo>()
    .constructor<ConstructorArg>({
      runtimeCheck: true,
    })
    .define("bar", ({ narrows }) =>
      narrows<{ name: string }>((arg) => {
        expectTypeOf(arg).toEqualTypeOf<ConstructorArg>();
        return { name: arg.name };
      }).run(async (arg) => {
        expectTypeOf(arg).toEqualTypeOf<{ name: string }>();
        expect(arg).toEqual({ name: "takibi" });
      }),
    );

  defined.registerHooks({
    bar: ({ constructorArg, methodName, arg, run }) => {
      expect(constructorArg).toEqual({ name: "takibi", unused: 1 });
      expect(methodName).toBe("bar");
      expect(arg).toBeUndefined();
      hooked += 1;
      return run();
    },
  });

  const instance = defined.new({ name: "takibi", unused: 1 });
  await instance.bar();
  expect(hooked).toBe(1);
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
    .define("use", ({ narrows }) =>
      narrows(({ a, b, c }) => {
        void c;
        return { a, b };
      }).run((arg) => {
        expectTypeOf(arg).toEqualTypeOf<{ a: string; b: number }>();
        expectTypeOf(arg).not.toHaveProperty("c");
        expect(arg).toEqual({ a: "x", b: 1 });
        return `${arg.a}:${arg.b}`;
      }),
    );

  expect(defined.new({ a: "x", b: 1, c: true }).use()).toBe("x:1");
});

test("method arguments reach run and a single-argument hook", () => {
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", ({ narrows }) =>
      narrows<{ prefix: string }>().run((arg, name) => `${arg.prefix} ${name}`),
    )
    .define("count", ({ narrows }) =>
      narrows<{ prefix: string }>().run((arg) => arg.prefix.length),
    );

  defined.registerHooks({
    greet: ({ constructorArg, methodName, arg, run }) => {
      expect(constructorArg).toEqual({ prefix: "hi" });
      expect(methodName).toBe("greet");
      expect(arg).toBe("ada");
      return run(arg);
    },
  });

  const instance = defined.new({ prefix: "hi" });
  expect(instance.greet("ada")).toBe("hi ada");
  expect(instance.count()).toBe(2);
  expectTypeOf(instance.greet).toEqualTypeOf<(name: string) => string>();
});

test("hook can skip run", async () => {
  let ran = 0;
  const defined = createClass<Foo>()
    .constructor<ConstructorArg>({
      runtimeCheck: true,
    })
    .define("bar", ({ narrows }) =>
      narrows<ConstructorArg>().run(async () => {
        ran += 1;
      }),
    );

  defined.registerHooks({
    bar: async () => {},
  });

  await defined.new({ name: "takibi" }).bar();
  expect(ran).toBe(0);
});

test("instance registerHooks replaces the hook table", () => {
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", ({ narrows }) =>
      narrows<{ prefix: string }>().run((arg, name) => `${arg.prefix} ${name}`),
    )
    .define("count", ({ narrows }) =>
      narrows<{ prefix: string }>().run((arg) => arg.prefix.length),
    );

  defined.registerHooks({
    greet: () => "class",
    count: () => 99,
  });

  const instance = defined.new({ prefix: "hi" });
  expect(instance.greet("ada")).toBe("class");
  expect(instance.count()).toBe(99);

  instance.registerHooks({
    greet: ({ run, arg }) => `instance ${run(arg)}`,
  });

  expect(instance.greet("ada")).toBe("instance hi ada");
  expect(instance.count()).toBe(2);
});

test("runtimeCheck wraps a failing narrows with the method name", () => {
  const defined = createClass<Foo>()
    .constructor<ConstructorArg>({
      runtimeCheck: true,
    })
    .define("bar", ({ narrows }) =>
      narrows<{ name: string }>((arg) => {
        if (typeof arg.name !== "string") {
          throw new Error("name is required");
        }
        return { name: arg.name };
      }).run(async (arg) => {
        void arg.name;
      }),
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
  const greet = incomplete.define("greet", ({ narrows }) =>
    narrows<{ prefix: string }>().run((arg, name) => `${arg.prefix} ${name}`),
  );
  expectTypeOf(greet).not.toHaveProperty("new");

  const defined = greet.define("count", ({ narrows }) =>
    narrows<{ prefix: string }>().run((arg) => arg.prefix.length),
  );
  expectTypeOf(defined).toHaveProperty("new");
  expectTypeOf(defined).toHaveProperty("registerHooks");

  // @ts-expect-error unknown method
  incomplete.define("missing", ({ narrows }) => narrows<{ prefix: string }>().run(() => undefined));

  // @ts-expect-error already defined
  greet.define("greet", ({ narrows }) =>
    narrows<{ prefix: string }>().run((arg) => arg.prefix.length),
  );
});

test("registerHooks accepts only a partial of the method surface", () => {
  const defined = createClass<Pair>()
    .constructor<{ prefix: string }>({
      runtimeCheck: true,
    })
    .define("greet", ({ narrows }) =>
      narrows<{ prefix: string }>().run((arg, name) => `${arg.prefix} ${name}`),
    )
    .define("count", ({ narrows }) =>
      narrows<{ prefix: string }>().run((arg) => arg.prefix.length),
    );

  defined.registerHooks({
    greet: ({ arg, run }) => run(arg),
  });

  const instance = defined.new({ prefix: "hi" });
  instance.registerHooks({
    count: ({ run }) => run(),
  });

  defined.registerHooks({
    // @ts-expect-error unknown method
    missing: () => undefined,
  });

  instance.registerHooks({
    // @ts-expect-error unknown method
    missing: () => undefined,
  });
});
