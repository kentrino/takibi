# `@takibi/invocation-lifecycle`

Platform-independent lifecycle for one invocation.

The package completes an already-decoded invocation through planning,
transaction execution, settlement, and notification:

```text
request
  -> createPlan
  -> executePlan
       none:  prepare(base) -> apply(base)
       apply: prepare(base) -> transaction { apply(tx) }
       full:  transaction { prepare(tx) -> apply(tx) }
  -> settle
  -> snapshotObserverEvent
  -> notify
```

It owns:

- checked lifecycle transitions;
- execution of an already-created `ExecutionPlan`;
- `none`, `apply`, and `full` transaction scopes;
- adapter updates retained before a later adapter failure;
- separate execution and transaction outcomes;
- success and failure settlement;
- observer snapshots, at-most-once notification, and observer-failure isolation.

It does not know whether an invocation is CRUD or an action. It does not
classify operations, authorize access, validate schemas, persist documents,
decode envelopes, aggregate batches, produce HTTP responses, trace work, or
construct a runtime.

## Runtime contract

The invocation type map keeps wire values, observer values, context, work,
prepared values, results, and failures opaque. Its runtime slot requires only
`storage`; all other runtime capabilities pass through without being named by
this package.

The runtime supplies:

- invocation and raw-input projection;
- plan creation;
- prepare/apply implementations for each transaction boundary;
- transaction execution and optional failure classification;
- failure mapping;
- observer snapshotting and notification.

The lifecycle owns the order in which those collaborators run. Runtime
composition and dependency injection stay outside the package.

## Public surface

Runtime values:

- `runInvocation`
- `executePlan`
- `invocationStageResult`
- `mergeInvocationUpdates`
- `unwrapInvocationAdapterResult`

The remaining exports are types needed to construct requests, plans, adapters,
results, updates, and observer events. Mutable lifecycle state and lifecycle
errors are package-private.

## Dependency boundary

The package has no production dependencies. It must not import Takibi API,
policy, logger, runtime, storage, HTTP, Cloudflare, Node, tracing, or container
packages.

Call-envelope and batch orchestration live as internal modules in
`@takibi/worker-runtime`.

## Development

```sh
vp run check
vp run test
vp run build
```
