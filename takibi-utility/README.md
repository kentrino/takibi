# `@takibi/takibi-utility`

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
constructor value after `define`'s identity cast or apply function. `args`
is always the method argument tuple. Call `next(...args)` to keep earlier
interceptors; `run(...args)` is the raw `define` body.

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

const instance = defined.newWithInterceptors(
  { prefix: "hi" },
  // otel() is an app helper that returns Partial<InterceptMap<Pair, Ctor>>
  otel(ctx, {
    greet: { name: "pair.greet" },
  }),
);
```

Compare construction and method calls with a native class:

```sh
vp run bench:create-class
```

`define<To>(name, run)` is an identity cast; `define<To>(name, fn, run)`
transforms at construction.

The apply function (or identity) always runs at construction so `run`
receives `deps`. `runtimeCheck` wraps a failing apply with the method name.

## `withTracing`

Wrap one async method of an existing instance. The returned object has the
same call surface; the original instance is unchanged. `method` must already
return a `Promise`. `run` is the injected span runner so this package does
not depend on a tracing backend.

```ts
import { withTracing } from "@takibi/takibi-utility";

const call = withTracing(instance, {
  method: "resolveContext",
  span: "takibi.resolve",
  kind: "internal",
  attributes: ({ decoded }) =>
    decoded.kind === "batch" ? { "takibi.batch.size": decoded.items.length } : undefined,
  run: (spec, fn) => withSpan(spec, fn),
});
```

The wrapper is a proxy over the original instance. Non-target methods and
getters keep that instance as `this`, including `#private` fields. `run`
receives the method arguments so logs and span attributes can be built from
the same typed input. `fn` is started at most once, including when `run`
calls it more than once or returns before it settles. Attribute-builder and
`run` failures must not replace the method result.
