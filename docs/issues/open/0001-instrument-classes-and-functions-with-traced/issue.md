---
title: Instrument classes and functions with traced
author: GPT-5
cost: 2
---

# Problem

Takibi currently declares method-level tracing at each construction site. A caller must combine
`withTracing`, which selects and proxies one async method, with `withLoggedSpan`, which implements
the span and log lifecycle. Instrumenting two methods requires two proxy layers:

```ts
const withCollection = withTracing(policy, {
  method: "evaluateCollection",
  span: TAKIBI_SPAN.policy,
  attributes: collectionAttributes,
  run: (spec, fn, args) => withLoggedSpan(logger, spec, collectionLogEvent(args), fn),
});

return withTracing(withCollection, {
  method: "evaluateAction",
  span: TAKIBI_SPAN.policy,
  attributes: actionAttributes,
  run: (spec, fn, args) => withLoggedSpan(logger, spec, actionLogEvent(args), fn),
});
```

This exposes the plumbing at every use site and makes interception look like a second tracing API.
`createCallResolveContext` also invents a one-method adapter object only so `withTracing` can wrap
it. `otel()` already has a typed method-spec map, but it targets unused
`createClass().newWithInterceptors()` and is not the production path.

A constructor-keyed strategy registry would be disproportionate. Production `withTracing` sites are
`PolicyEvaluator` (two methods), `ActionHandler.run`, `SchemaParser.parse`, and the resolve
function.

# Proposal

Replace `withTracing` and `otel()` with one worker-runtime helper, `traced`. It binds a logger and
defaults the runner to `withLoggedSpan`. Name it `traced`, not `otel` or `trace`: the helper does
not call OpenTelemetry, and `trace` collides with `@opentelemetry/api`.

Class instances take a method map. Functions take one spec. Do not encode the function case as
`{ apply }`; `apply` is a real `Function` method and does not mean `fn()`.

```ts
const policy = traced(new PolicyEvaluator(), logger, {
  evaluateCollection: {
    name: TAKIBI_SPAN.policy,
    event: "takibi.policy",
    attributes: collectionPolicyAttributes,
    logFields: collectionPolicyLogFields,
  },
  evaluateAction: {
    name: TAKIBI_SPAN.policy,
    event: "takibi.policy",
    attributes: actionPolicyAttributes,
    logFields: actionPolicyLogFields,
  },
});

const resolve = traced(resolveContext, logger, {
  name: TAKIBI_SPAN.resolve,
  event: "takibi.resolve",
  attributes: ([input]) => resolveAttributes(input),
  logFields: ([input]) => resolveLogFields(input),
});
```

Overload discrimination: a third argument with top-level `name` and `event` is a function spec;
otherwise it is a method map. Infer each configured method's argument tuple and reject unknown or
synchronous methods. `attributes` and `logFields` receive that argument tuple. Factory-only fields
such as `ActionHandlerCtor.actionName` are closed over at the construction site; do not introduce a
constructor or `ctor` parameter.

`traced` owns the instance or function it returns. Domain classes stay unaware of instrumentation.
No `Traceable` base class, no constructor-identity registry, no process-global strategy, and no
runtime injection of a default policy table.

Preserve the current `withTracing` guarantees for `this`, private fields, getters, property writes,
frozen instances, exactly-once method execution, and instrumentation-failure isolation. The function
overload intercepts `[[Call]]`, not `Function#apply`.

# APIs to remove

Delete the superseded wrappers after migration. Do not keep them as a compatibility layer.

| Existing API                                         | Disposition | Reason                                                                                                                                                          |
| ---------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTracing`                                        | Delete      | One-method proxy plus injected `run` is the problem this issue replaces. Move any needed proxy mechanics into `traced`.                                         |
| `otel` / `OtelMethodSpec` / `OtelSpec`               | Delete      | Interceptor-map builder for unused `createClass` production path. Reuse the spec fields (`name`, `kind`, `event`, `attributes`, `logFields`), not the function. |
| `tracePolicyEvaluator`                               | Delete      | Becomes `traced(new PolicyEvaluator(), logger, { evaluateCollection, evaluateAction })`.                                                                        |
| `traceSchemaParser`                                  | Delete      | Becomes `traced(new SchemaParser(), logger, { parse })`.                                                                                                        |
| `traceActionHandler`                                 | Delete      | Becomes `traced(new ActionHandler(...), logger, { run })` with factory fields closed over.                                                                      |
| Resolve adapter object in `createCallResolveContext` | Delete      | Wrap the resolve function directly.                                                                                                                             |

Update `@takibi/utility` exports and README, worker-runtime public exports, and the contract /
runtime READMEs that mention `withTracing`. `createClass` itself stays; this issue does not require
an interceptor adapter for it.

# Helpers that stay

`traced` wraps a class instance or a function. Do not force lexical or recursive sites through it.

| Existing API         | Representative code snippet                                                            | Expected disposition      | Reason                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `withSpan`           | `withSpan({ name: TAKIBI_SPAN.request, kind: "server" }, run)`                         | Keep                      | Request scopes and other lexical blocks are not a stored class or function to wrap. This remains the low-level span lifecycle primitive. |
| `withLoggedSpan`     | `withLoggedSpan(logger, spec, { event: "takibi.wire" }, send)`                         | Keep, preferably internal | `traced` should call it. Direct calls remain valid for lexical scopes and for the executor, which needs the live span.                   |
| `tracedStorage`      | `tracedStorage(driver).transaction(work)`                                              | Keep                      | `transaction` re-wraps the scoped driver. A flat method map cannot express that.                                                         |
| Direct executor span | `withLoggedSpan(logger, executorSpec, fields, async (span) => recordSettlement(span))` | Keep                      | Settlement failures are returned, not only thrown. Generic method timing is not enough.                                                  |

# Implementation

1. Define `traced` in worker-runtime with the two overloads and a shared spec shape (`name`, `kind`,
   `event`, `attributes`, `logFields`). Argument tuples are inferred per async method or function.
2. Implement instance wrapping as one proxy for every configured method. Leave unconfigured methods
   unchanged. Port the `withTracing` guarantees rather than calling `withTracing`.
3. Implement function wrapping through `[[Call]]`. `createCallResolveContext` should return
   `traced(fn, logger, spec)` and drop the adapter object.
4. Migrate `PolicyEvaluator`, `SchemaParser`, `ActionHandler`, and the resolve function. Close over
   `ActionHandler` factory fields in the spec.
5. Delete `withTracing` and its utility exports/tests, `otel()` and its interceptor tests, and the
   dedicated `trace*` wrappers.
6. Keep `withSpan`, `withLoggedSpan`, `tracedStorage`, and the executor settlement span. Document
   those remaining sites from the table above.

# Scope

Included:

- `traced` for class instances (method map) and async functions (single spec)
- Compile-time method-name and argument-tuple inference
- One wrapper per instance or function; no nested `withTracing`
- Migration of the four production sites
- Removal of `withTracing`, `otel()`, and the dedicated `trace*` wrappers
- Unit and integration tests for runtime behavior and type safety

Excluded:

- A constructor-keyed or global strategy registry
- Runtime injection of a default instrumentation table
- `{ apply }` as the function convention
- Requiring domain classes to inherit from a tracing base class
- Adapting `createClass().newWithInterceptors()`
- Moving `tracedStorage`, request `withSpan`, or the executor settlement span onto `traced`
- Changing span names, attributes, log event schemas, propagation, or failure-isolation semantics

# Acceptance Criteria

- `traced(new Foo(), logger, { run: ... })` infers `Foo.run` arguments and rejects unknown or
  synchronous methods in type-level tests.
- `traced(fn, logger, { name, event, attributes, logFields })` infers `fn` arguments and wraps
  direct calls (`fn(...)`), not `fn.apply`.
- One `traced` call instruments every configured method on an instance and leaves unconfigured
  methods unchanged.
- Instrumented native classes preserve private fields, prototype dispatch, getters, setters, frozen
  instances, caller-supplied receivers, and exactly-once execution.
- Attribute, logger, and tracer failures never replace the method's or function's result or
  exception.
- `PolicyEvaluator.evaluateCollection` and `evaluateAction` are configured together without nested
  proxies.
- `createCallResolveContext` no longer allocates a one-method adapter object.
- `withTracing`, `otel`, `OtelMethodSpec`, `OtelSpec`, `tracePolicyEvaluator`, `traceSchemaParser`,
  and `traceActionHandler` are gone from sources and public exports.
- Existing span names, attributes, log fields, nesting, exception status, and duration events remain
  unchanged in worker-runtime integration tests.
- Remaining `withSpan`, `withLoggedSpan`, `tracedStorage`, and executor usages match the table in
  this issue.
- `vp check` and `vp test` pass.

# Related Files

- `packages/utility/src/with-tracing.ts`
- `packages/utility/src/index.ts`
- `packages/utility/README.md`
- `packages/worker-runtime/src/otel.ts`
- `packages/worker-runtime/src/logging.ts`
- `packages/worker-runtime/src/tracing.ts`
- `packages/worker-runtime/src/invocation-collaborators.ts`
- `packages/worker-runtime/src/schema.ts`
- `packages/worker-runtime/src/context/worker-call.ts`
- `packages/worker-runtime/src/context/executors.ts`
- `packages/worker-runtime/src/invocation-execution.ts`
- `packages/worker-runtime/src/index.ts`
- `packages/worker-runtime/README.md`
- `packages/invocation-lifecycle/README.md`
