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

```ts
import { createClass, narrows } from "@takibi/takibi-utility";

type Pair = {
  greet: (name: string) => string;
  count: () => number;
};

const defined = createClass<Pair>()
  .constructor<{ prefix: string }>({
    runtimeCheck: true,
  })
  .define("greet", {
    narrows: narrows<{ prefix: string }, { prefix: string }>((arg) => arg),
    run: (arg, name) => `${arg.prefix} ${name}`,
  })
  .define("count", {
    narrows: narrows<{ prefix: string }, { prefix: string }>((arg) => arg),
    run: (arg) => arg.prefix.length,
  });

defined.registerHooks({
  greet: ({ constructorArg, methodName, arg, run }) => {
    void constructorArg;
    void methodName;
    return run(arg);
  },
});

const instance = defined.new({ prefix: "hi" });
instance.registerHooks({
  count: ({ run }) => run(),
});
```

`narrows` always runs at construction so `run` receives the narrowed argument.
`runtimeCheck` wraps a failing `narrows` with the method name. A hook receives
the original constructor argument, the method name, the method argument, and a
`run` already bound to the narrowed argument.
