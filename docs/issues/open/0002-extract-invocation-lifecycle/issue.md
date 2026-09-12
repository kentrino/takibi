---
title: Extract the invocation lifecycle from worker runtime contracts
author: GPT-5.6
cost: 5
---

# Problem

`@takibi/worker-runtime-contract` is named and documented as a contract package, but it currently
owns several different kinds of behavior:

- the lifecycle of one invocation, including planning, transaction execution, settlement, and
  notification;
- the `Call` envelope pipeline, including decode, context resolution, dispatch, response
  conversion, and terminal observation;
- single and batch call composition;
- Takibi-specific action and collection transaction-boundary classification;
- runtime policy, schema, action-handler, and adapter-map composition types;
- dependency graphs for both invocation execution and Worker envelopes.

The package therefore has a broad root entry and more than one reason to change. Its strongest
boundary is the invocation lifecycle: it contains substantial platform-independent invariants,
can be tested without Worker, storage, HTTP, tracing, or container implementations, and prevents
runtime composition concerns from entering the lifecycle.

The other responsibilities do not currently justify independent packages. `Call` and single/batch
composition have one runtime owner and change with runtime dispatch. The adapter map, graph, policy,
schema, handler, and transaction-classification types describe Takibi runtime composition rather
than a generic invocation lifecycle.

# Proposal

Replace `@takibi/worker-runtime-contract` with `@takibi/invocation-lifecycle`.

The package has one purpose:

> Complete one invocation through planning, transaction execution, settlement, and notification.

It owns:

- lifecycle state and checked transitions;
- execution of an already-created `ExecutionPlan`;
- `none`, `apply`, and `full` transaction scopes;
- application of explicit adapter updates, including updates retained on failure;
- success and failure settlement;
- transaction outcome classification;
- observer-event snapshotting and at-most-once notification;
- isolation of observer failures from the settled invocation result.

It does not own:

- HTTP or wire envelope decoding;
- application-context resolution;
- single or batch call composition;
- response/status conversion;
- CRUD or action classification;
- the table that assigns Takibi operations to transaction boundaries;
- policy evaluation, schema parsing, action handlers, persistence, tracing, or concrete storage;
- runtime adapter-map or container dependency graphs.

# Invocation lifecycle

The lifecycle receives invocation-time values and explicitly injected collaborators:

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

The runtime decides what the invocation means and creates its plan. The lifecycle executes that
plan without knowing whether the operation is CRUD, a document action, or a detached action.

The package should expose a deliberately small root. The target value exports are:

```ts
runInvocation;
executePlan;
invocationStageResult;
mergeInvocationUpdates;
unwrapInvocationAdapterResult;
```

Only types required to construct lifecycle adapters, plans, requests, results, updates, and observer
events remain exported. `InvocationState`, lifecycle phase types, settlement implementation details,
and lifecycle errors stay private unless an external caller demonstrably needs them.

# Worker runtime ownership

Move the envelope pipeline into internal `@takibi/worker-runtime` modules:

```text
worker-runtime/src/envelope/
  call.ts
  invocation.ts
  response.ts
```

`invocation.ts` holds the single and sequential batch call composition; both share one
resolved-request pipeline, so they live in one module. Local execution wires through these
runners, keeping the sequential batch loop in a single implementation.

The runtime owns:

- `Call` and `runCall`;
- decode -> resolve context -> dispatch -> response;
- call-level failure and terminal observation;
- single and sequential batch execution;
- response/status conversion;
- envelope adapter types and dependency graph.

Do not create a separate Call package. It has no independent consumer or release boundary today.
Extract one only if a second host needs the same envelope lifecycle without depending on the Worker
runtime.

Move Takibi-specific invocation composition into runtime-local modules:

- `RuntimeAdapterMap` and runtime registration projections;
- policy, schema, and action-handler surfaces;
- action preparation composition;
- action and collection plan criteria;
- `transactionBoundaryOf` and plan builders;
- runtime adapter keys and graphs.

Delete the broad `RUNTIME_ADAPTER_GRAPH` if it remains unused after the move. Keep the actual
Worker envelope graph beside its runtime composition root.

# Dependency direction

The target dependency graph is:

```text
invocation-lifecycle
        ^
        |
worker-runtime
  |- Takibi plan classification
  |- policy/schema/action execution
  |- envelope and batch composition
  |- Worker/DO/storage/container integration
```

The lifecycle package must not import:

- `@takibi/worker-runtime`;
- `@takibi/api`;
- `@takibi/policy`;
- `@takibi/logger`;
- concrete storage packages;
- Hono, Cloudflare, Node, tracing, or container libraries.

Invocation, context, failure, result, and runtime values are generic type-map slots. Storage remains
the only capability that transaction execution needs to project explicitly. Avoid adding
Takibi-shaped `collections`, `registry`, `logger`, or `services` requirements to the generic base
type map.

# Migration

1. Add lifecycle characterization and package-boundary tests before changing behavior.
2. Move lifecycle state, execution flow, generic plan types, and generic adapter-result helpers into
   `@takibi/invocation-lifecycle`.
3. Make the lifecycle type map opaque with respect to Takibi wire requests, failures, logger,
   collections, registry, and services.
4. Move `Call`, single/batch composition, and status response behavior into worker-runtime envelope
   modules with their existing tests.
5. Move Takibi plan classification and action preparation composition into worker-runtime.
6. Define the runtime adapter map locally from lifecycle adapters plus Takibi collaborators.
7. Remove obsolete aliases, exported state internals, adapter keys, and unused graphs.
8. Delete `@takibi/worker-runtime-contract` after all consumers use the new package.
9. Update package manifests, aggregate TypeScript inputs, lockfile, READMEs, dependency tests, and
   related issue references.

Move behavior before simplifying types. Do not combine the extraction with changes to transaction,
authorization, validation, failure, notification, batching, or tracing semantics.

# Scope

Included:

- one narrowly scoped invocation-lifecycle package;
- runtime-local Call and envelope modules;
- runtime-local Takibi adapter composition and plan classification;
- removal of the old contract package;
- a smaller lifecycle public entry;
- dependency and platform boundary enforcement;
- documentation matching the new ownership.

Excluded:

- a separately published Call package;
- changes to public `takibi` APIs;
- new transaction boundaries;
- changes to operation classification;
- parallel batch execution;
- new retry, cancellation, or concurrency semantics;
- persistence, policy, schema, action, tracing, or HTTP behavior changes;
- compatibility exports for the private old package.

# Acceptance Criteria

- `@takibi/invocation-lifecycle` can be described as completing one invocation through plan
  execution, settlement, and notification.
- The lifecycle package has no dependency on Takibi API, policy, logger, runtime, storage, HTTP,
  Cloudflare, Node, tracing, or container packages.
- The lifecycle root does not export `Call`, batch helpers, status-response helpers, runtime adapter
  maps, container graphs, policy/schema/action surfaces, or Takibi plan classifiers.
- `InvocationState` is package-private unless a production consumer requires it.
- The runtime owns the unchanged action/collection transaction-boundary table.
- Call decode, context resolution, dispatch, response conversion, and terminal observation behavior
  remain unchanged.
- Batch execution remains sequential, preserves input order, and continues after a failed item.
- Transaction reuse does not open a nested transaction or emit a duplicate notification.
- `none`, `apply`, and `full` preserve their current prepare/apply scopes.
- Execution and transaction outcomes remain distinct, including commit, rollback, and unknown
  outcomes.
- Explicit intermediate updates remain observable when a later adapter result fails.
- Settlement occurs once and notification runs at most once after settlement.
- Observer snapshot or notification failure never changes the invocation result.
- The old package name, imports, manifest entries, aggregate build input, and lockfile importer are
  removed.
- Package-boundary tests enforce both the new lifecycle floor and the Worker/platform edge.
- Package checks, focused tests, recursive tests/builds, and packed-consumer e2e tests pass.

# Related Files

- `packages/worker-runtime-contract/src/flow.ts`
- `packages/worker-runtime-contract/src/state.ts`
- `packages/worker-runtime-contract/src/type.ts`
- `packages/worker-runtime-contract/src/prepare.ts`
- `packages/worker-runtime-contract/src/request.ts`
- `packages/worker-runtime-contract/src/call.ts`
- `packages/worker-runtime-contract/src/status-response.ts`
- `packages/worker-runtime-contract/src/plan.ts`
- `packages/worker-runtime-contract/src/graph.ts`
- `packages/worker-runtime/src/adapter-map.ts`
- `packages/worker-runtime/src/invocation-plan.ts`
- `packages/worker-runtime/src/invocation-prepare-apply.ts`
- `packages/worker-runtime/src/context/worker-call.ts`
- `packages/worker-runtime/package.json`
- `packages/worker-runtime/README.md`
- `packages/tsconfig.takibi-pack.json`
- `packages/takibi/package.json`
- `packages/takibi/tests/package-boundary.test.ts`
- `packages/logger/tests/package-boundary.test.ts`
