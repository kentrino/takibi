# `@takibi/takibi-utility`

Shared utilities for Takibi packages.

The package is dependency-light and does not import the Takibi runtime, HTTP
framework, storage, or Cloudflare APIs.

## `createClass`

Fix a method surface first, declare the constructor argument, then define each
method. `new` and `registerHooks` are typed only after every method is defined.

Hooks are not part of `define`. Register a `Partial` of the method surface on
the defined class or on an instance. Instance registration replaces the hook
table completely.

`ctor` is the value passed to `new`. `deps` is what `narrows` produced for
that method. `args` is always the method argument tuple; replay with
`run(...args)`.

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

defined.registerHooks({
  greet: ({ ctor, deps, methodName, args, run }) => {
    void ctor;
    void deps;
    void methodName;
    return run(...args);
  },
});

const instance = defined.new({ prefix: "hi" });
instance.registerHooks({
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
