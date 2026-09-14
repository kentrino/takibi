# `@takibi/worker-runtime`

Cloudflare Worker and Durable Object execution for Takibi.

The package owns the runtime composition around
`@takibi/invocation-lifecycle`:

- `createTakibi`, public HTTP routing, and wire protocol adaptation;
- Worker, Durable Object, and in-process execution;
- Call-envelope decode, context resolution, dispatch, response conversion,
  terminal observation, and sequential batch composition;
- Takibi action and collection classification into `none`, `apply`, and `full`
  transaction plans;
- policy, schema, action-handler, and prepare/apply collaborators;
- concrete storage, action registry, collections, services, logger, and tracing
  wiring;
- response projection from settled invocation results.

`@takibi/invocation-lifecycle` owns only the platform-independent progression
of one invocation:

```text
createPlan -> executePlan -> settle -> notify
```

The runtime creates a Takibi-specific plan. The lifecycle executes the selected
transaction boundary without knowing whether the work is CRUD, a document
action, or a detached action.

Worker public HTTP decodes and resolves application context once. Production
dispatch forwards one envelope through a Durable Object stub. Durable Object
and in-process execution share `resolveLocalExecution`, which resolves the same
invocation adapters and executes batch items sequentially.

Document validation, revisions, uniqueness, migrations, and restore integrity
belong to `@takibi/documents`. Query construction, policy grant composition,
collection/action builders, browser clients, and Node SQLite test adapters
belong to their respective packages.

The runtime depends inward on the Takibi domain packages and
`@takibi/invocation-lifecycle`. Node SQLite remains isolated in
`@takibi/testing`; browser clients do not reach this package.

## Instrumentation wrappers

`traced` instruments async methods on one class instance with a single method
map, or instruments one async function with a single spec. It binds the
runtime logger and uses the shared span and log lifecycle while preserving the
wrapped value's result, exception, receiver, private fields, and property
behavior. Domain classes do not inherit tracing behavior.

Request scopes and other lexical blocks continue to use `withSpan`.
`withLoggedSpan` remains the low-level span and log helper for lexical work and
the executor settlement span, which needs the live span. `tracedStorage`
continues to re-wrap transaction-scoped storage because a flat method map
cannot express that relationship.
