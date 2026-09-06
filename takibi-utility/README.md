# `@takibi/takibi-utility`

Shared utilities for Takibi packages.

The package is dependency-light and does not import the Takibi runtime, HTTP
framework, storage, or Cloudflare APIs.

## `createClass`

Fix a method surface first, declare the constructor argument, then define each
method. `new` is typed only after every method is defined.

Interceptors are not part of `define`. After `new`, `$intercept` takes a
`Partial` of the method surface. It merges: listed methods are updated, other
interceptors stay, and a new interceptor wraps the previous one through
`next`. `$replace` replaces the whole table. The `$` prefix keeps this off
the domain method surface.

`ctor` is the value passed to `new`. `deps` is the constructor value after
`define`'s identity cast or apply function. `args` is always the method
argument tuple. Call `next(...args)` to keep existing interceptors;
`run(...args)` is the raw `define` body.

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
  .define<{ prefix: string }>("greet", (deps, name) => `${deps.prefix} ${name}`)
  .define<{ prefix: string }>("count", (deps) => deps.prefix.length);

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

`define<To>(name, run)` is an identity cast; `define<To>(name, fn, run)`
transforms at construction.

The apply function (or identity) always runs at construction so `run`
receives `deps`. `runtimeCheck` wraps a failing apply with the method name.
