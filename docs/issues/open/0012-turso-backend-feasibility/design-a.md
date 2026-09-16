# Design A: Private comparison of equivalent semantics (recommended)

## Decision and evidence

Reassessed on 2026-09-16: retain as an open research issue. `packages/storage/src/types.ts` already defines an async StorageDriver and callback transactions, but `storage.ts` owns SqlStorage SQL/layout and `snapshot/src/maintenance.ts` uses lease/staging tables. `worker-runtime/src/context/backend.ts` separates stub execution from testing-backend wiring. The existence of an interface alone is not evidence of remote support. The lifecycle extraction in `1b1de81` also isolates generic execution; it does not approve a remote backend.

[Cloud](https://docs.turso.tech/turso-cloud) (checked on 2026-09-16) lists **both libSQL and Turso** and describes the new Turso Cloud engine as early preview (`turso db create --tursodb`). This corrects the outdated premise that hosted storage is libSQL-only. [Concurrent writes](https://docs.turso.tech/tursodb/concurrent-writes) documents a single-writer default, opt-in MVCC/BEGIN CONCURRENT, and rollback/retry after commit conflicts, but its local examples do not establish equivalent hosted behavior from Workers. Preview fails this issue's production gate but is not a reason to close the research.

## First principles, boundaries, and alternatives

The need is to measure constraints on a workload that keeps all data within one consistency boundary, rather than to increase the number of backends. Ideally, SQL/transaction/maintenance differences stay within a private adapter and results are compared with identical fixtures. Consume existing package entry points without first generalizing production StorageDriver for remote differences. The purpose of the private experiment package is to reproduce evidence of compatibility and performance. Limit its scope to the benefit of changing and verifying fixtures and adapters together; avoid the maintenance cost of public APIs or fragmented new packages.

[A](./design-a.md) tests whether the current contract can be preserved while improving performance. [B](./design-b.md) distributes load by partitioning existing DOs, but loses cross-partition atomicity, so it is not a substitute if the entire marketplace needs atomic workflows. Doing nothing is reasonable if the current workload already fits DO limits. Actual workload measurements and the need for cross-partition transactions remain unverified; check them against the baseline at the start of the experiment.

## Example

Production wiring remains identical before and after. Only researchers execute the same fixtures through a private harness (the following is a proposed API, not a product API).

```ts
// Before: Run the fixture only against the supported backend
await runParity({ backend: durableObjectFixture, fixture: marketplaceFixture });
// After: Evaluate the same contract against multiple candidates
for (const backend of [durableObjectFixture, hostedLibSqlFixture, hostedTursoFixture]) {
  await runParity({ backend, fixture: marketplaceFixture });
}
```

The harness records unavailable backends in result.md with reasons for skipping them and does not count them as passes. Callback conflicts return one failure without automatic replay. Record uncertain commits as unknown and reread data to check invariants.

## Verification status and decision-sensitive assumptions

This reassessment only read storage/maintenance/backend code, Git history, and official documentation. No cloud account or token was used, and no remote benchmark or prototype was run or created. The numeric gates below are research criteria retained from the existing issue, not SLOs confirmed by the user from measurements. Compare fixture representativeness with baseline results, and record any changes to criteria before measurement rather than adjusting them to fit results. Check Workers-client transaction/migration SQL compatibility with a minimal hosted smoke test; if it fails, record the candidate as incompatible. Separate adoption from research completion: a negative result can complete the research once evidence covers every gate.

## Retained detailed specification and acceptance criteria

## Problem

Takibi production execution routes an application-selected partition to one SQLite-backed Durable
Object. Schema, actions, transactions, initialization, maintenance, and storage for that partition
run in the same coordination unit. This scales across partitions, but a product that intentionally
places its whole marketplace in one partition inherits the throughput and storage limits of one
Durable Object.

The repository now separates reusable capabilities into packages such as `@takibi/storage`,
`@takibi/query`, `@takibi/policy`, `@takibi/snapshot`, and `@takibi/worker-runtime`. That separation
makes a remote SQLite-compatible prototype possible, but does not prove backend compatibility:

- atomic actions, optimistic revisions, and uniqueness must survive concurrent writers;
- conflict handling must not transparently replay an action callback with external side effects;
- initialization, index reconciliation, seeds, and maintenance need database-enforced exclusion
  across Worker isolates;
- remote SQL round trips must deliver a real throughput gain over one Durable Object;
- export, restore, and reset must exclude normal operations and cut over atomically;
- the selected hosted engine must support the SQL and transaction behavior Takibi actually uses.

As verified on 2026-09-16, Turso Cloud documents both libSQL and the new Turso engine; the latter
is early preview. Concurrent-write MVCC is opt-in and can return commit conflicts. Preview does
not pass the production-readiness gate. Recheck the exact hosted engine/runtime support at
experiment time; local MVCC documentation does not establish hosted Workers compatibility.

## Proposal

Create a private discovery prototype without changing the supported backend contract or public API.
Place it in an independently testable private workspace package such as
`packages/turso-prototype`; do not export it through `takibi`, mention it as supported in README, or
change production application wiring.

Compare:

1. the current SQLite-backed Durable Object baseline;
2. production-supported hosted libSQL;
3. a hosted Turso Database concurrent-write option, only if officially available to the test
   environment when measurements run.

If the third option is unavailable or pre-release, record that as a failed production-readiness gate.
Do not treat local/embedded MVCC results as evidence that a Cloudflare Worker can use the same model
against hosted storage.

## Prototype requirements

- Use an official client that runs in Cloudflare Workers and an internal async SQL interface local
  to the prototype. Do not generalize Durable Object `SqlStorage.exec` or `transactionSync` into a
  premature production interface.
- Reuse collection definitions, actions, policy, query compilation, migrations, and snapshot
  lifecycle through their package entry points where possible. Any required internal import is a
  finding about the current boundary.
- Model one remote database as one Takibi partition. Do not add shared-table row tenancy or
  database-per-user provisioning.
- Keep URLs and tokens in environment bindings; commit no credentials or captured production data.
- Record SQL/layout differences from current document, index catalog, maintenance, and staging
  tables.

## Correctness and failure injection

- Serialize layout migration, seed, and index reconciliation across isolates with a database lease
  or equivalent database-enforced mechanism.
- Prototype a database-enforced uniqueness mechanism; do not rely only on application scans under
  concurrent transactions.
- Execute each action callback at most once. If conflict recovery requires replaying the callback,
  classify the backend as incompatible with the current action contract.
- Inject write conflicts, transaction timeouts, and connection loss before and after commit. Record
  when commit outcome is unknown and demonstrate that revision, balance/ledger, and uniqueness
  invariants are not silently violated.
- Make maintenance exclusion visible to all isolates in the database; a process-local active count
  cannot protect restore or reset.

## Parity and measurement

Run the same fixtures against Durable Objects and candidates for get, put, delete, indexed and
unindexed list, cursor, count, transaction, JSON scalar semantics, missing/null behavior, string and
range operators, composite indexes, lazy migrations, and logical snapshots.

Benchmark colocated Worker deployments at concurrency 1, 8, 32, and 128 for read-heavy traffic,
independent writes, one hot-record write, and multi-document atomic workflows. Record request count,
duration, throughput, p50/p95/p99 latency, conflict/timeout/overload/retry counts, failure rate,
regions, versions, durability plan, transaction mode, and warm/cold state in `result.md`.

## Promotion gate

Reconsider an official backend only if all of the following hold:

- zero invariant violations under correctness and failure-injection tests;
- no transparent replay of application callbacks;
- at least 2× the sustained Durable Object throughput for independent writes at concurrency 32;
- p95 latency at most 2× the Durable Object baseline and failure rate below 1%;
- read-heavy sustained throughput no lower than the baseline;
- distributed initialization and maintenance exclusion without a permanent external coordinator;
- an officially supported hosted engine/runtime combination, not only a local or preview feature.

If any gate fails, discard promotion. A read-only projection or analytics path is a separate
capability and not success for this issue. Even after all gates pass, return backend API and ADR
changes to the normal RFC process instead of adding a public entry point here.

## Acceptance criteria

- The prototype is private, absent from public exports, and does not alter the generated Durable
  Object or existing tests.
- One fixture runs against all available candidates and reports automated semantic differences.
- At least 100 concurrent uniqueness attempts leave exactly one successful document.
- Conflicting multi-document writes preserve balance/ledger invariants without lost updates.
- Conflict handling never executes the action callback or mock service call more than once.
- Connection loss around commit and transaction timeouts are classified without silent partial
  commits.
- Concurrent initialization does not corrupt layout, seeds, or index catalog.
- Export/restore/reset exclude or drain normal operations across simulated isolates and cut over
  atomically.
- Reproducible benchmarks and `result.md` evaluate every promotion gate and record platform maturity.
- Passing results do not add a public backend in this issue; failing results do not leak prototype
  code into production wiring.
- `vp check` and the existing supported-backend test gates pass.

## References

- [Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference)
- [Turso Cloud](https://docs.turso.tech/turso-cloud)
- [Turso concurrent writes](https://docs.turso.tech/tursodb/concurrent-writes)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
