# Collection operation isolation and transaction responsibilities

This document records the design specification and decisions from checking the collection
isolation PR review against the implementation. The baseline is `f0e9e63`, inspected on
2026-09-15; deletion-race changes present in the working tree at inspection time are identified
separately. Proposed improvements are tracked in the linked issues. This document does not
change the current transaction boundaries.

## Decisions

The review is right to distinguish the invariants to preserve from the lock scope used to
preserve them. Single-row operation isolation, lazy migration safety, and trusted multi-step
transactions have different responsibilities. Some proposed solutions, however, omit conditions
that must be resolved before adopting them as specifications.

| Topic | Assessment | Disposition |
| --- | --- | --- |
| `full` for `set/update/delete/get` | Appropriate for the current architecture and the PR's purpose | Responsibilities recorded here |
| External I/O and reentry inside policy | Real risks, but not currently rejected automatically | [Contract documentation issue](../issues/open/0005-policy-io-contract/issue.md) |
| Long transactions for `list/count` | A valid concern; calling them excessive requires examining guarantees and costs | [Investigation and design issue](../issues/open/0006-list-count-isolation/issue.md) |
| Routing trusted operations through `executePlan` | No current justification for changing the route | Responsibilities recorded here |
| Returning `MIGRATION_CONFLICT` for a disappeared row | Treating the row as normally absent is appropriate | Fix and verify in the original PR |
| Pushing changes and updating the PR title/body | PR completion work, not a code specification | No new issue or spec needed |

## Guarantees to preserve

For `set/update/delete`, another operation must not change the target row between reading it,
checking the revision precondition, evaluating policy, and performing the final mutation.
For example, a delete authorized because a row belongs to owner A must not delete that row
after another operation has transferred it to owner B.

Uniqueness is not a condition on the target row alone. Checks for conflicts with other rows
and the final write must share an isolation boundary. Rechecking only the target row's `rev`
does not guarantee uniqueness. A database transaction also does not place an external
authorization service or mutable JavaScript objects in the same snapshot.

For `get`, return the document used for authorization. If reading performs a lazy migration,
its persistence must also be considered. The current `full` boundary groups reading,
migration, and authorization, rolling back database changes within the operation if a later
stage fails. This is a valid implementation; it does not mean every read inherently requires
a write transaction.

Lazy migration must not overwrite an updated row with a value derived from an older read.
For ordinary update races, recheck the revision and schema version inside the persistence
transaction. If they changed, transform the latest row and validate index and uniqueness
constraints again. This responsibility belongs in the migrating wrapper shared with trusted
operations, rather than depending exclusively on a public operation's `full` boundary.

## Current boundaries and ownership

| Layer | Responsibility |
| --- | --- |
| `executePlan` in `@takibi/invocation-lifecycle` | Execute generic `none/apply/full` plans without knowledge of ACLs or collection semantics |
| Plan classification and prepare/apply in `@takibi/worker-runtime` | Select each operation's boundary and compose authorization, revision handling, and mutation |
| Migrating wrapper in `@takibi/worker-runtime` | Transform and safely persist migrations, including index and uniqueness revalidation |
| `@takibi/storage` | Coordinate SQL operations and transactions; nested transactions on a scoped driver join the existing transaction |
| `$transaction` on the trusted facade | Commit or roll back caller-selected operations together within one DO |

Policy-bound collections currently select `apply` for `add` and `full` for every other
operation. `full` includes both prepare and apply in the transaction; `apply` includes only
apply. Operations inside an existing atomic action join its enclosing transaction.

Trusted `add/set/update` open the necessary write transactions in typed-storage. Bypassing
policy-bound plans for `get/list/delete` is not itself a defect. Trusted operations bypass
ACLs, but retain schema, uniqueness, and storage guarantees. To group calls, use the facade
passed to the callback as specified by the
[existing trusted transaction contract](../../packages/takibi/docs/spec/transactions.md).

The review overstates the claim that routing trusted operations through `executePlan` would
necessarily require adding or duplicating ACL logic. The executor is generic, so plans
without ACLs are technically possible. However, the current ownership can provide the
required safety without adding that wiring in this PR. Being able to describe a separate
responsibility also does not, by itself, justify extracting another package.

## Corrections concerning policy and asynchronous work

`AccessContext` extends `TCtx` with `collection/operation/permission/where/doc/nextDoc`.
It does not supply a standard collections facade, but the type does not prohibit networking
capabilities captured in application context or closures. For `list/count`, the executor
does not supply a target row as `doc` and evaluates the `list` permission.

`AccessPolicyFn` permits `Promise<AccessGrant>`. The current types and evaluator do not
detect external I/O or reentry and reject them immediately. Documenting restrictions in the
README can prevent misuse, but cannot itself guarantee failure before a circular wait.

Takibi's root driver coordinates operations through one `operationQueue`. Subsequent root
driver operations wait until the transaction callback finishes. If a policy inside that
transaction waits for another operation queued behind it, a circular wait results.
A fetch or RPC back into the same DO can cause this. External HTTP does not always produce
a circular wait, but the coordination boundary remains held while the request is awaited.

Synchronous SQL does not guarantee a short overall operation. Policy computation,
asynchronous schema validation, migration, and uniqueness scans also take time. There is
no performance guarantee that a local decision is always cheap.

Moving external I/O into an action handler is not sufficient. Atomic action handlers run
inside transactions, and atomic document actions include prepare in their `full` boundary.
Placement guidance must identify the actual transaction start rather than merely saying
to perform the work before the handler.

A future read-release-authorize-recheck protocol would also require more than checking the
target `rev`. That check alone does not validate external authorization revocation or
conditions depending on other rows. The validity period of authorization results, dependent
state, and retry limits need separate design; uniqueness must be checked at commit time.

## Corrections concerning list/count

Atomic migration of each row and a snapshot of an entire page are different guarantees.
If an update occurs between reading the first and second halves of a page, each row may
be valid while the page as a whole does not represent any single point in time.

The current `storage.list` reads chunks, awaits a transform for each row, and evaluates
`where` against transformed values to fill the page. A small result does not necessarily
mean a small scan. `countDocuments` additionally reads multiple pages, so page-level
consistency alone cannot make the entire count reflect one point in time.

Changing `full` to `apply` leaves the entire list/count performed by
`executeResolvedCollection` inside the apply transaction. It can move policy execution
outside the transaction, but does not resolve prolonged occupancy caused by scanning
and migration.

Separating in-memory migration for responses from persistence is worth considering.
However, it requires a design for candidate-row snapshots, post-transform filtering,
indexes and cursors, uniqueness, persistence on partial failure, and count consistency.
The current `StorageDriver` has no independent read-snapshot API. A short read cannot
be assumed to be an already available solution.

The current `full` boundary is therefore not classified as a correctness bug. A separate
issue investigates whether performance can improve while preserving the guarantees.
An optimization must not release a boundary established by an enclosing atomic action
or `$transaction`.

## Remaining work in the original PR

If a row has disappeared when rechecked, returning absence to the read layer is appropriate;
the old migration result must not recreate it. At inspection time, the working tree already
contained changes making `migrateDocument` return `null`, making list skip the row, and
adding tests. Those were existing changes, neither modified nor execution-tested as part
of this documentation work. The calling `get` converts absence to the usual `NOT_FOUND`.
This does not mean every failure in the initial migration or validation should be converted
to absence.

Whether changes have been pushed and whether the PR title and body are appropriate require
checking the hosting service. The review's statement that only two items remain is an
assessment made at that time. This document does not certify completion of the entire PR
or provide an exhaustive safety review.

## Evidence

- [Plan classification](../../packages/worker-runtime/src/invocation-plan-contract.ts): `transactionBoundaryOf`
- [Generic executor](../../packages/invocation-lifecycle/src/flow.ts): `executePlan`
- [Collection execution, trusted facade, and count](../../packages/worker-runtime/src/executor.ts): `resolveCollection`, `executeResolvedCollection`, `createTrustedCollections`, `countDocuments`
- [Policy types](../../packages/policy/src/types.ts): `AccessContext`, `AccessPolicyFn`
- [SQL coordination and pagination](../../packages/storage/src/storage.ts): `coordinate`, `paginate`, `paginateIndex`
- [Storage interface](../../packages/storage/src/types.ts): `StorageDriver`
- [Migration](../../packages/worker-runtime/src/migrations.ts): `createMigratingStorage`, `migrateDocument`
- [Trusted single-row operations](../../packages/worker-runtime/src/typed-storage.ts): `storageAdd`, `storageSet`, `storageUpdate`, `storageDelete`
- [Uniqueness checks](../../packages/worker-runtime/src/unique.ts): `assertUniqueDocument`
- [Schema validation](../../packages/worker-runtime/src/schema.ts): `parseSchemaUnobserved`
- [Action prepare/apply](../../packages/worker-runtime/src/invocation-prepare-apply.ts)

Cloudflare's [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)
includes SQL queries on the SQLite backend in `storage.transaction`. The
[input/output gate documentation](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work)
was also consulted. Those platform gates and Takibi's `operationQueue` described here are
separate mechanisms.
