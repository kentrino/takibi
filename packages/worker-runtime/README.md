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
