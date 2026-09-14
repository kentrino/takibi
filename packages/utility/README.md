# `@takibi/utility`

Shared utilities for Takibi packages.

The package is dependency-light and does not import the Takibi runtime, HTTP
framework, storage, or Cloudflare APIs.

## `createClass`

Fix a method surface first, declare the constructor argument, then define each
method. `new` is typed only after every method is defined.

Interceptors are not part of `define`. Pass them to `newWithInterceptors` as
one or more `Partial` maps of the method surface. Later maps wrap earlier
ones through `next`. Listed methods are updated; methods omitted from a map
keep the previous interceptor. `new` builds the same instance with no
interceptors. The instance is only the method surface.

`ctor` is the value passed to `new` or `newWithInterceptors`. Interceptors
receive that whole `ctor` so cross-cutting wrappers such as OpenTelemetry
can read fields the method View dropped. `deps` is only for `run`: the
constructor value passed directly by `define(name, run)` or transformed by an apply function. `args`
is always the method argument tuple. Call `next(...args)` to keep earlier
interceptors; `run(...args)` is the raw `define` body.

```ts
import { createClass } from "@takibi/utility";

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

const defined = createClass<Pair>()
  .constructor<{ prefix: string }>({
    runtimeCheck: true,
  })
  .define("greet", (deps, name) => `${deps.prefix} ${name}`)
  .define("count", (deps) => deps.prefix.length);

const instance = defined.newWithInterceptors(
  { prefix: "hi" },
  {
    greet: ({ args, next }) => `intercepted ${next(...args)}`,
  },
);
```

Compare construction and method calls with a native class:

```sh
vp run bench:create-class
```

`define(name, run)` passes the constructor value as dependencies;
`define<To>(name, fn, run)` transforms it at construction.

The apply function (or identity) always runs at construction so `run`
receives `deps`. `runtimeCheck` wraps a failing apply with the method name.
