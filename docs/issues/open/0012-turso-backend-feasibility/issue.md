---
title: Measure whether a Turso backend can preserve Takibi semantics and improve scale
author: OpenAI Codex
cost: 8
priority: P3
priority_reason: "This is workload-specific discovery with no proven production path; correctness and operational issues in the supported Durable Object backend come first."
category: research
source_issue: 0056-turso-backend-feasibility
---

# Problem

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

As of this issue's migration, Turso Cloud documentation describes hosted libSQL as the current
managed engine. Its write transactions serialize at the primary, while concurrent writes in the
new Turso Database engine use MVCC and may return commit conflicts. Hosted/serverless availability
and support status can change, so they must be recorded at experiment time rather than assumed.

# Proposal

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

# Prototype requirements

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

# Correctness and failure injection

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

# Parity and measurement

Run the same fixtures against Durable Objects and candidates for get, put, delete, indexed and
unindexed list, cursor, count, transaction, JSON scalar semantics, missing/null behavior, string and
range operators, composite indexes, lazy migrations, and logical snapshots.

Benchmark colocated Worker deployments at concurrency 1, 8, 32, and 128 for read-heavy traffic,
independent writes, one hot-record write, and multi-document atomic workflows. Record request count,
duration, throughput, p50/p95/p99 latency, conflict/timeout/overload/retry counts, failure rate,
regions, versions, durability plan, transaction mode, and warm/cold state in `result.md`.

# Promotion gate

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
changes to the normal design process instead of adding a public entry point here.

# Acceptance criteria

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

# References

- [Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference)
- [Turso Cloud](https://docs.turso.tech/turso-cloud)
- [Turso concurrent writes](https://docs.turso.tech/tursodb/concurrent-writes)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
