# Cache wrappers by underlying driver identity

## Decision and evidence

Keep 0008 open at P3. `packages/worker-runtime/src/tracing.ts:176` allocates a wrapper and closures per call; its transaction callback calls the local `wrap(scoped)` again. `context/executors.ts:createInProcessExecutor` and `durable-object.ts:fetch` choose raw versus wrapped drivers on every request. The driver lifetime is longer than the individual request.

`withSpan` reads the active tracing backend store for each operation; the wrapper captures only its driver, not tracer, span, request, or tenant. History `e441a07` (“preserve span semantics in core”) explicitly assigns kind/attributes/error policy to core and translation to adapters. `59c5178` later consolidates call instrumentation through `traced`; wrapper caching need not change either boundary. The reason wrappers were originally recreated is not documented in the inspected history. No performance regression or measured latency improvement has been established.

## Recommended design

From a clean design, a traced storage capability would belong to the underlying driver identity and consult request context only at operation time. Implement this locally with a module-scoped `WeakMap<StorageDriver, StorageDriver>` in tracing.ts. Return an existing wrapper on a hit, create/cache on a miss, and have the transaction callback call `tracedStorage(scoped)`.

Keep per-request `resolveTracer` and raw/traced selection in the two entry paths. This preserves disabled tracing and means an in-flight request continues to use its bound tracer even if global registration changes; subsequent requests use their newly resolved tracer. A cached wrapper must never capture global registration at creation. Different drivers, including distinct transaction scopes, remain distinct. The cache is keyed by the input driver, not by storage contents or partition name.

The weak key avoids cache-only ownership of a driver even though its wrapper closes over that driver. A retained wrapper necessarily retains its driver; do not promise otherwise. Do not add a second strong registry or nondeterministic GC-based unit test.

## Example

Internal callers keep the same API:

```ts
const a = tracedStorage(driver);
const b = tracedStorage(driver);
// Before: a !== b. After: a === b.
await a.transaction(async (scoped) => {
  await scoped.get("posts", "p1");
});
```

Before and after, the get operation uses the currently active request tracer and parent span. Repeated callbacks receiving the same scoped-driver object get the same wrapper after the change; fresh scoped-driver objects still require fresh wrappers. There is no public API or persisted/wire-data migration.

## Comparison and verification

Caching in each executor would also save root wrappers but duplicates ownership between Node and DO entry points and misses transaction scopes. Strong `Map` ownership risks retaining dead drivers. A new storage package abstraction adds APIs/wiring without independent domain behavior or benefit. Doing nothing is acceptable if this small allocation saving fails to justify its test/maintenance cost; no urgency or performance claim follows from allocation count alone.

Verified here by source inspection: wrapper allocation, transaction recursion, both request entry paths, and active-context lookup. No benchmark or implementation test was run. Implement identity tests with the same and different fake drivers, including backend-reused scoped identities. Reuse the existing `packages/takibi/tests/tracing.test.ts` Node coverage and Workers tracing path to check counts, attributes, parents, no-tracer behavior, and register/remove/replace across requests. Add concurrent requests with different bound tracers so cache reuse cannot cross-contaminate context. Inspect weak ownership structurally. Backend scoped-driver reuse frequency is unknown and does not affect correctness; a performance claim would additionally require profiling a representative workload.

## Original Scope

In scope:

- identity caching for root and transaction-scoped `StorageDriver` wrappers;
- regression coverage across tracer registration changes;
- unchanged in-process and Durable Object storage-span semantics.

Out of scope:

- span names, kinds, attributes, parentage, or error behavior;
- eliminating allocations when a backend always creates a new scoped driver;
- removing per-request tracer resolution;
- general storage optimization or allocation benchmarks.

## Original Acceptance criteria

- Repeated `tracedStorage` calls for one driver return the same object by strict equality.
- Different driver identities return different wrappers.
- Reusing one scoped driver identity across transaction callbacks returns one traced wrapper.
- Registering, unregistering, and replacing a tracer after wrapper creation uses the currently active
  tracer and records spans in the replacement tracer.
- Requests without tracing use the raw driver and create no storage spans.
- Existing storage span counts, attributes, and parent relationships remain unchanged in the
  in-process and Workers test paths.
- The cache does not strongly retain an otherwise unreachable driver.
- `vp check`, worker-runtime tests, and the repository-wide test gate pass.
