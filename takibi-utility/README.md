# `@takibi/takibi-utility`

Shared utilities for Takibi packages.

The package is dependency-light and does not import the Takibi runtime, HTTP
framework, storage, or Cloudflare APIs.

## `createClass`

Fix a method surface first, declare the constructor argument, then define each
method. `new` and `$intercept` are typed only after every method is defined.

Interceptors are not part of `define`. Register a `Partial` of the method
surface on the defined class or on an instance. `$intercept` merges: listed
methods are updated, other interceptors stay, and a new interceptor wraps the
previous one through `next`. `$replace` replaces the whole table. The `$`
prefix keeps this off the domain method surface.

`ctor` is the value passed to `new`. `deps` is what `narrows` produced for
that method. `args` is always the method argument tuple. Call `next(...args)`
to keep existing interceptors; `run(...args)` is the raw `define` body.

```ts
import { createClass } from "@takibi/takibi-utility";

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

const defined = createClass<Pair>()
  .constructor<{ prefix: string }>({
    runtimeCheck: true,
  })
  .define("greet", ({ narrows }) =>
    narrows<{ prefix: string }>().run((deps, name) => `${deps.prefix} ${name}`),
  )
  .define("count", ({ narrows }) =>
    narrows<{ prefix: string }>().run((deps) => deps.prefix.length),
  );

defined.$intercept({
  greet: ({ ctor, deps, methodName, args, next }) => {
    void ctor;
    void deps;
    void methodName;
    return next(...args);
  },
});

const instance = defined.new({ prefix: "hi" });
// otel() is an app helper that returns Partial<InterceptMap<Pair, Ctor>>
instance.$intercept(
  otel(ctx, {
    greet: { name: "pair.greet" },
  }),
);
instance.$replace({
  count: ({ run, args }) => run(...args),
});
```

Compare construction and method calls with a native class:

```sh
vp run bench:create-class
```

`define` receives a `narrows` already bound to `ctor`, so only the deps type
is written. `narrows<To>()` is an identity cast; `narrows<To>(fn)` transforms
at construction.

`narrows` always runs at construction so `run` receives `deps`.
`runtimeCheck` wraps a failing `narrows` with the method name.
