# `@takibi/takibi-worker-runtime-contract`

Internal call and invocation contracts for Takibi Worker runtimes.

The package is platform-independent. It owns lifecycle state, storage-isolation
dispatch, settlement, notification, and the policy / schema / handler
interfaces those contracts name. `LogEvent`, `LogLevel`, and `InternalLogger`
come from `@takibi/takibi-logger` and are re-exported here. Schema, policy,
persistence, tracing, log output, concrete storage, and wire protocol
implementations stay in `@takibi/takibi-worker-runtime`.

These are internal execution contracts, not an application-facing compatibility
promise. The observer boundary supports a future public `onResponse` option;
providing that option is a separate runtime concern.

## Vocabulary and execution flow

- A **call** is one HTTP or wire envelope containing one invocation or a batch.
- An **invocation** is one CRUD operation or action. Batch is call composition,
  not a separate invocation work kind.
- `Call` is the envelope runner class. Its constructor takes the envelope
  adapter-map slots (`callDecode`, `callResolveContext`, `callDispatch`,
  conversion, and observers). `ENVELOPE_ADAPTER_GRAPH.call` lists those
  dependencies so a runtime can `inject(Call)` on the same graph. `run`
  owns decode → resolve → dispatch → response. Observation failures are
  isolated inside `Call`, not at each notify site. `runCall` is the thin
  `new Call(adapters).run(request)` entry. Terminal events include the
  request and decoded value when decode succeeded, so observers are not an
  execution-data store. A failing failure converter rejects instead of
  converting again. Instance methods such as `resolveContext` stay overridable;
  a runtime wraps the resolve adapter with `withTracing`, not `Call.run`.
- `runSingleCall` / `runBatchCall` are local envelope executors. They extract
  wire invocation(s), invoke `invocationRun`, and convert results. Batch runs
  sequentially and preserves input order. Worker production dispatch forwards
  one envelope and does not use these runners.
- The runtime creates a plan for each invocation. `work` describes the
  operation; `transactionBoundary` selects its storage boundary.
- Plan creation decides the operation and transaction boundary only. It does
  not load documents or run authorization or input validation.
- The invocation runner owns plan creation, plan execution, settlement, and
  notification order. The DI graph owns construction dependencies, not
  execution order.

```text
call:        decode -> resolveContext -> dispatch -> response
invocation:  createPlan -> executePlan -> settle -> notify

executePlan internals:
  prepare -> apply

none   prepare(base) -> apply(base)
apply  prepare(base) -> transaction { apply(tx) }
full   transaction { prepare(tx) -> apply(tx) }
```

| Runtime operation                                                 | Boundary |
| ----------------------------------------------------------------- | -------- |
| Collection `get` / `list` / `count` / `set` / `update` / `delete` | `none`   |
| Collection `add`                                                  | `apply`  |
| Non-atomic detached or document action                            | `none`   |
| Detached atomic action                                            | `apply`  |
| Document atomic action                                            | `full`   |

These names describe the range the runner wraps in a new transaction, not
general database isolation levels. `none` means this execution does not open a
new transaction; it does not forbid joining an existing one. `full` wraps
prepare and apply only; plan creation, settlement, and notification stay
outside. Runtime-owned work types and plan creation establish the valid
operation/boundary combinations. The generic contract does not duplicate CRUD
permissions, concealment rules, or action definitions.

## Public surface

The package root exports:

1. `Call`, the envelope runner class, `runCall`, its thin function entry, and
   `EnvelopeAdapterMap` / `ENVELOPE_ADAPTER_GRAPH` for the `call` DI node.
2. `InvocationState`, the lifecycle class with JavaScript private fields and
   checked semantic transitions.
3. `runInvocation`, the adapter-injected single-invocation lifecycle.
4. `executePlan`, the already-planned transaction-boundary dispatcher.
5. `runSingleCall` / `runBatchCall` and their `create*TakibiCall` binders.
6. `TakibiContractConfigurationError` / `TakibiContractStateError` and type-only
   adapter, view, request, transaction-boundary, transaction-outcome, and result
   contracts.
7. `composeActionPreparation`, `invocationStageResult`,
   `unwrapInvocationAdapterResult`, and `mergeInvocationUpdates`. The composer
   owns identify → authorize → parse order and successful-update acceptance.
   `invocationStageResult` turns a throwing stage into an adapter result without
   inventing updates or wrapping the original error. Direct callers unwrap that
   same error; top-level settlement uses `InvocationState.acceptAdapterResult`.

`executePlan` preserves execution errors and supports explicitly reusing an
existing transaction via `reuseTransaction`. It does not settle or notify;
those belong to the top-level invocation lifecycle. Reusing an existing
transaction must not create a second top-level notification.

`ExecutionPlan` is the generic plan type. `InvocationPlan<T>` applies an
invocation type map to that plan. `transactionBoundaryOf` and the action /
collection plan builders own Takibi's boundary table: document atomic actions
are `full`, other atomic actions and collection `add` are `apply`, and the
remaining current operations are `none`. Classification adapters supply
target / atomic / operation criteria and work; they do not pick a boundary.

`InvocationRuntime` is the standalone collaborator bag. It does not require
input, result, or work types. `InternalInvocationTypeMap` names that bag as
`runtime` and constrains `wireInvocation` to a single action or collection
request, `invocation` to the observer-safe copy without raw `input`, `context`
to an object and `failure` to `TakibiFailure<string>`. Execution results retain
the concrete runtime type; response adapters own serialization. The lifecycle
does not assert that storage documents or other execution values are JSON.
Concrete runtimes bind a narrower `runtime` plus result, context, and
work/prepared types through the same map; those specifics are not replaced by
the common bound. Views and transaction storage read `T["runtime"]` so
collections, storage, registry, logger, and services stay at their concrete
types. Raw/validated input and prepare/apply payloads stay `unknown` here so
implementation types remain in the runtime.

## Adapter composition

`RuntimeAdapterMap<T>` declares every local runtime slot directly. Its single
`RuntimeTypeMap` argument supplies invocation, request, decoded, response, and
local-execution types; context comes from the invocation type map. The default
argument permits `keyof RuntimeAdapterMap` without constructing placeholder types.
`AdapterMap<TInvocation>`, `CallAdapterMap<T>`, and `Adapters<T, K>` are `Pick`
projections of that full map, not building blocks used to assemble it.
Call composers stay on the map as
`callSingle` / `callBatch`; a runtime facade can select that projection when
it needs a Call pipeline. A wire or HTTP body that is `StatusBearingResult`
(`ok` plus `error.status` on failure) can be projected with
`jsonResponseFromStatus` and a `JsonResponseLike` factory; Fetch `Response`
is not part of this package. `RUNTIME_ADAPTER_GRAPH` is the local-execution dependency graph
for those slots. `invocationPrepareApply` depends on
`invocationPolicy`, `invocationSchema`, and `invocationActionHandler`;
`transactionNone` / `transactionApply` / `transactionFull` alias that
one prepare/apply node. Those three slots, and `InvocationRuntime.logger`,
are typed on this map (`PolicySurface`, `SchemaSurface`, the handler factory,
and `InternalLogger` from `@takibi/takibi-logger`). Implementations and
tracing stay in the runtime.
`PolicySurface.evaluateCollection` infers context and document types from the
collection definition. Its access context cannot widen those types. This protects
calls with typed definitions, including calls through a contract-typed adapter.
The runtime collection registry uses `CollectionDefinition<any, TCtx>`. Its schema
has already been erased, so these calls cannot prove document correspondence.

`PolicySurface.evaluateAction` is an erased registry dispatch boundary.
`eraseForRegistry` converts authored actions to `RuntimeActionDefinition` before
this method runs. Action builders check the authored policy relationships.
The evaluator receives unknown guard output and document values. It does not
recover or prove the original action context and document types.

`InvocationPrepareApplyDeps` is `Pick` of those collaborator slots.
`ENVELOPE_ADAPTER_GRAPH` is the Worker / testing envelope
Call graph: `call` depends on `ENVELOPE_CALL_ADAPTER_KEYS` and does not
require invocation or storage adapters. `EnvelopeAdapterMap` is that
surface plus the constructed `Call` instance derived from the same type
arguments.
Instrumentation values stay off this type. Keys use flat camelCase prefixes
such as `callDecode`, `invocationCreatePlan`, `transactionNone`, and
`transactionRun`. `INVOCATION_ADAPTER_KEYS` lists the slots `runInvocation`
reads. `INVOCATION_PREPARE_ADAPTER_KEYS` lists the collaborator slots
`invocationPrepareApply` reads. `CALL_SINGLE_ADAPTER_KEYS` / `CALL_BATCH_ADAPTER_KEYS` list the slots
`createSingleTakibiCall` / `createBatchTakibiCall` read.
`ENVELOPE_CALL_ADAPTER_KEYS` lists the Worker envelope Call slots.

The map is the source of adapter signatures. Runners consume its selected slots
directly; no second execution-shaped adapter bag or renaming layer is needed.
The map includes both supplied capabilities and functions constructed from them.

The contract does not depend on tatenuki or any container API. The Worker runtime
uses tatenuki at its composition roots. Local / DO execution registers
factories on `RUNTIME_ADAPTER_GRAPH` and obtains injected `invocationRun`,
`callSingle`, `callBatch`, and `localExecution`. Worker / testing HTTP
registers factories on `ENVELOPE_ADAPTER_GRAPH` plus request-scoped
construction slots and obtains an injected `Call` instance. Individual
adapters receive explicit adapter subsets, not a container or a
general-purpose `get` function.

```ts
import {
  runInvocation,
  type InternalInvocationTypeMap,
  type InvocationAdapters,
  type InvocationRunOptions,
} from "@takibi/takibi-worker-runtime-contract";

function execute<T extends InternalInvocationTypeMap>(
  adapters: InvocationAdapters<T>,
  options: InvocationRunOptions<T>,
) {
  return runInvocation<T>(adapters, options);
}

// A runtime-injected runner takes only invocation-time values:
// await resolvedAdapters.invocationRun({
//   request: { wireInvocation, context },
//   invocationRuntimeChecks: true,
// });
```

Direct calls and injected calls execute the same runner. The Worker runtime
resolves one `RuntimeAdapterMap` at its composition root.

## Request, state, views, and observer events

`InvocationRunOptions<T>` contains invocation-time values, not adapters:

```ts
type InvocationRunOptions<T extends InternalInvocationTypeMap> = {
  readonly request: {
    readonly wireInvocation: T["wireInvocation"];
    readonly context: T["context"];
  };
  readonly invocationRuntimeChecks?: boolean;
};
```

`request.context` is the app-resolved context. Guards may refine or replace it.
The runner allocates one `InvocationState` per invocation; reusable runners do
not retain request state between calls.

`State` owns lifecycle fields and transitions. `View` is a readonly projection
passed to adapters. `ObserverEvent` is the notification payload: settled
facts, observer-safe invocation, `ObservedInput` (validated input or
unavailable), and settlement outcome. It does not carry services. The runner
owns adapter and observer calls. State does not execute business operations or
open transactions.

Mutable carrier fields use JavaScript `#private` storage. Adapters receive
small, purpose-specific views, never the State instance or an update handle.
Views share payload references such as app context: carrier encapsulation does
not imply deep payload immutability. View creation does not deep-clone payloads
or introduce per-phase proxies.

Adapters return `InvocationAdapterResult` values. Explicit updates are applied
before a failed result is rethrown, preserving relevant intermediate progress
for settlement and observation. Validated action input is recorded when parsing
completes, including when a later transaction cannot start. Arbitrary thrown
errors do not automatically preserve intermediate updates; adapter boundaries
must return the information that needs to remain observable.

Views do not claim to invalidate old references or automatically narrow the
State instance after a method call. Checked accessors and semantic transitions
provide the runtime guarantee. A narrow view must not be cast into a complete
lifecycle state.

## Transaction boundaries and operation invariants

The runner, not a boundary implementation, opens the public invocation
transaction. Boundary methods receive scoped storage. The reusable runtime
record retains base storage and is never replaced with a transactional driver.

- Plan creation does not load the target document. The plan contains no loaded
  document, grant, existing document, next document, or transactional storage.
  Runtime work is passed directly to execution without reconstructing an older
  executor request from a parallel contract model.
- `none.prepare`, `apply.prepare`, and `full.prepare` return ephemeral
  `T["nonePrepared"]`, `T["applyPrepared"]`, and `T["fullPrepared"]` values for
  their corresponding `apply`. Prepared business data does not accumulate on
  the shared carrier. `full` runs prepare then apply inside one transaction.
- Actions preserve guard -> target load/gate -> input parse -> handler order.
  Guard failure must not read the target; gate denial must precede parsing.
- Document atomic actions load, authorize, parse, and run inside the same
  runner-owned transaction. Detached atomic actions authorize and parse on base
  storage, then run the handler in the transaction.
- CRUD preparation, authorization, and concealment retain their existing order,
  including authorization used to conceal preparation failures. ADR 0015 applies
  to CRUD `get` / `update` / `delete` / `set`; a document-action gate denial is
  `ForbiddenError`, not a concealed `NotFoundError`.
- Direct and handler-internal execution must preserve these boundaries, including
  existing-transaction participation, without duplicate transactions or notices.

## Failure and notification

Call-level decode, tenant validation, context resolution, projection, and
response-conversion errors throw. Failures before invocation execution do not
reach its observer. Invocation failures settle through `invocationToFailure`;
a throwing mapper is captured as a mapping failure. Configuration errors caught
inside the invocation lifecycle settle as configuration failures; construction
or call-level configuration failures may throw.

A failed invocation result does not abort subsequent batch items. This relies
on the injected runner honoring the settlement contract; DI types alone do not
prove the behavior of arbitrary replacements. Mapped failures are
`TakibiFailure<string>` values. Wire or HTTP adapters wrap those values as
`{ ok: false; error }` when they project a response.

Transaction outcome is recorded separately from execution outcome. A successful
transaction settles as `committed` only after the transaction runner resolves,
not merely when its callback returns. A failed transaction is `rolled-back`
only with adapter confirmation; otherwise it is `unknown`. Non-transactional
work remains `none`, which does not imply that no write or partial write occurred.
Failure stages (`classify`, `execute`, `commit`, `rollback`) identify where a
failure occurred, not a sequence every invocation traverses. `classify` remains
the observed identifier for failures before plan execution; `commit` remains
the observed identifier for actual transaction-commit failure.

Notification runs at most once per invocation lifecycle, after settlement.
`invocationNotify` receives the event only; a runtime binds services when it
constructs the observer. `invocationSnapshotObserverEvent` creates the
observer-owned data graph before `invocationNotify` runs. Snapshot or observer
failure is recorded separately and must not change settlement or the HTTP/wire
response. A shallow freeze alone cannot protect nested response data. Snapshot
policy belongs to the runtime; generic contract payloads cannot be assumed to
support structured cloning. Binding services at construction does not promise
to isolate arbitrary service side effects.

`callRuntimeChecks` may be a boolean or a function. A function is evaluated once
at call start, and the resulting boolean is passed unchanged as
`invocationRuntimeChecks` to each invocation. Disabling optional phase assertions
does not disable slot-integrity or notification single-shot checks.

## Runtime boundaries

- Worker HTTP decodes public requests and resolves application context once.
  Its production dispatch encodes the wire envelope and calls the DO stub.
- DO execution uses the context received in the wire envelope; it does not run
  the application resolver again. DO and in-process execution share invocation
  contracts and runtime adapters.
- Full single/batch execution composers belong on DO / in-process execution
  paths. Do not bind them to the Worker stub transport hop or replace one batch
  envelope with one stub fetch per item.
- Runtime response adapters preserve single-call success/failure status and
  batch HTTP 200 with per-item wire results.
- Adapter lifetimes must match their captured values. Request context, prepared
  documents, grants, and transaction storage remain invocation-time values.
  Request-specific tracing context must not leak into a longer-lived runner.

`Call` is a normal TypeScript class and a DI graph node. Platform decode,
context resolve, dispatch, conversion, and observation stay on runtime
adapter factories; the contract re-exports the logger interface from
`@takibi/takibi-logger` and does not import HTTP or tracing types.
`createClass` remains a
runtime tool for separating business method views from OTEL interceptors.
Interceptors use constructor metadata and compose through `next`; business
methods see their narrow views. Instances capturing phase data are
constructed only after that view exists, not cached across invocations.
Preserve existing span boundaries instead of collapsing policy, schema, and
action work into one span. No tracer or class-building mechanism belongs in the
contract's execution flow.

Collection persistence, user-defined action implementations, nested collection
helpers, schema/unique/revision rules, migrations, and runtime construction stay
in the runtime. A vocabulary or DI change is not a reason to introduce new
persistence abstractions or operation-specific top-level orchestrators.

## Development

```sh
vp run check
vp run test
vp run build
```

Regression coverage should verify transaction-scoped target reads, guard/gate/
parse order, CRUD concealment, intermediate updates on failure, observer
isolation, sequential batch continuation, and adapter lifetime separation.
Production wiring lives in `@takibi/takibi-worker-runtime`: DO `fetch` and
in-process executors resolve one runtime map that binds wire/HTTP calls around
the shared `invocationRun`. Worker public HTTP still decodes and resolves once,
then forwards one Call envelope through a single stub hop.

Envelope `CallAdapters` require `callToResponse`, including when dispatch already
returns the response type (`({ dispatched }) => dispatched`). Dispatch and
response types cannot be connected by an implicit conversion.

In `InvocationUpdates`, omitted or undefined fields leave state unchanged.
`{ input: { status: "validated", value: undefined } }` explicitly records a
validated undefined input; it is distinct from an absent input update.
