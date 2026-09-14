---
title: Make public collection operations and lazy migrations transactionally isolated
author: OpenAI Codex
cost: 5
---

# Problem

Takibi exposes optimistic document revisions, policy-checked collection operations, unique
constraints, and lazy document migrations. Those guarantees currently do not share one isolation
boundary for a complete public operation.

`@takibi/worker-runtime` splits a collection invocation into `prepare` and `apply` stages. The
current plan table gives `add` an `apply` transaction but assigns `none` to `set`, `update`,
`delete`, `get`, `list`, and `count`. Consequently, state-dependent work performed during
`prepare` is not isolated from the later write:

- `set` and `update` read the current document, check the requested revision, construct the next
  document, and evaluate policy before `apply` persists it;
- `delete` evaluates policy against a document that can change before the delete runs;
- `get`, `list`, and `count` can perform lazy migration read-transform-write work through the
  migrating storage wrapper.

The SQLite-backed Durable Object storage coordinates each individual storage call, but that does
not make a sequence of calls atomic. Two requests can both read revision 1, both pass the same
revision precondition, both return success with revision 2, and overwrite one another. A delete
can be authorized using an older document and then remove a newer version. A lazy migration can
transform a stale row and overwrite a newer revision committed while the transform was running.

The existing revision tests cover sequential stale writes. They do not hold an asynchronous policy
or migration at a barrier while a competing request attempts to modify the same document, so these
interleavings are not fixed by the current test suite.

# Proposal

Treat one policy-bound collection operation as the minimum storage isolation boundary whenever
its preparation depends on stored state or its read path can write a lazy migration.

Use the existing generic transaction boundaries as follows:

| Collection operation | Boundary | Reason |
| --- | --- | --- |
| `add` | `apply` | Schema and policy preparation do not read existing state; collision and unique checks join the write transaction. |
| `set` / `update` / `delete` | `full` | Read, revision check, policy evaluation, validation, unique check, and mutation must observe one storage state. |
| `get` / `list` / `count` | `full` | A read may perform lazy migration and must not publish a partially migrated or stale result. |

`full` means both `prepare` and `apply` receive the same transaction-scoped `StorageDriver`.
Transaction-scoped calls to `transaction()` must join that transaction instead of opening another
one. This preserves atomic action behavior: collection operations inside an existing atomic action
reuse its transaction, while every operation inside a non-atomic action keeps its own independent
transaction and earlier successful operations remain committed if a later operation fails.

Revision semantics remain unchanged at the API boundary:

- when a revision precondition is supplied, at most one concurrent write against that revision can
  succeed and the others fail with `STALE_WRITE`;
- when the revision is omitted, last-write-wins remains supported, but each successful write derives
  its revision from the latest committed document and advances it exactly once.

Lazy migration must also be safe when the migrating storage wrapper is used outside a full public
operation. Before writing a migrated document, re-read the row inside the transaction and confirm
that its revision and stored schema version still match the source that was transformed. If they do
not match, discard the stale transformed value, migrate the latest row, and re-evaluate schema,
index, and unique constraints. Never overwrite a newer row with an older migration result.

# Package boundaries

- `@takibi/invocation-lifecycle` continues to own only the domain-independent execution of
  `none`, `apply`, and `full` plans. It must not learn which Takibi operation needs which boundary.
- `@takibi/worker-runtime` owns the collection-operation boundary table, state-dependent
  preparation, policy evaluation, revision handling, and lazy-migration orchestration.
- `@takibi/storage` owns transaction coordination and the guarantee that nested transactions on a
  scoped driver join the active transaction. Its interface does not gain a public compare-and-swap
  operation for this change.
- `@takibi/testing` must exercise the same SQLite transaction behavior as the Durable Object path so
  concurrency results do not differ between test and production backends.

The one-sentence responsibility of this change is: **ensure that every policy-bound collection
operation observes and mutates one consistent storage state.** No public API is added.

# Implementation notes

- Change `transactionBoundaryOf` and the collection plan types in
  `packages/worker-runtime/src/invocation-plan-contract.ts` so state-dependent collection
  operations can select `full`.
- Keep transaction execution in `@takibi/invocation-lifecycle`; pass the same scoped storage through
  `resolveCollection` and `executeResolvedCollection` for a `full` plan.
- Ensure `prepareSetDoc` and `prepareUpdateDoc` receive only the document read from the active
  transaction. Do not re-read through the root driver during `apply`.
- Run document policy and unique checks in the same transaction as the eventual mutation, including
  when policy evaluation is asynchronous.
- Update `createMigratingStorage` so migration persistence validates the source revision and stored
  schema version inside the transaction and retries from the latest row after a conflict.
- Retain and strengthen the nested-transaction contract in `packages/storage/src/storage.ts`; a
  scoped driver must not expose intermediate work to the root coordinator.
- Cover direct public requests, policy-bound collections used by actions, and operations already
  running inside a trusted or atomic transaction.
- Document the per-operation atomicity and optimistic revision guarantees in the Takibi README.

# Scope

In scope:

- facade-level isolation for public and policy-bound collection operations;
- commit-time consistency of revision checks, policy decisions, unique checks, and writes;
- stale-write prevention for lazy migration;
- nested transaction joining across worker-runtime, storage, and the SQLite testing backend;
- deterministic concurrency tests for both the in-process SQLite path and a SQLite-backed Durable
  Object.

Out of scope:

- removing last-write-wins when a client omits `rev`;
- transactions spanning multiple requests, tenants, or Durable Objects;
- rolling back external I/O performed by application policy or action code;
- making all operations in a non-atomic action one transaction;
- snapshot restore, index backfill, or a new SQL-level compare-and-swap public API.

# Acceptance criteria

- Two concurrent `set` or `update` requests using the same expected revision produce exactly one
  success and one `STALE_WRITE`; the committed document matches the successful response.
- If two concurrent writes omit `rev` and both succeed, they receive distinct consecutive revisions
  and the final revision advances twice.
- An `update` racing a `delete` cannot apply a policy decision made against an older document to a
  newer document.
- A lazy migration paused before persistence cannot overwrite a newer committed revision. It either
  migrates the latest row safely or returns the existing migration failure without modifying it.
- Schema validation, state-dependent policy evaluation, revision checks, unique checks, and the
  final write use the intended transaction-scoped driver for `set` and `update`.
- `get`, `list`, and `count` never expose a result produced by a stale lazy-migration write.
- Collection operations inside an atomic action join the action transaction. Operations inside a
  non-atomic action remain independently committed.
- Transaction-boundary unit tests cover the complete collection-operation table and preserve the
  separation between Takibi classification and the generic lifecycle executor.
- The Node SQLite testing backend and the Workers Durable Object tests demonstrate the same
  concurrency outcomes with barrier-controlled interleavings.
- `vp check`, `vp run -r test:workers`, and the repository-wide test gate pass.
