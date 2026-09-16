# Storage count with explicit migration-safe eligibility

## Decision and evidence

Retain open. `executor.ts:561` implements count with repeated list calls; `StorageDriver` has no aggregate. `createMigratingStorage.list` always supplies a plan, even without migration steps. Crucially, no migrations does not mean arbitrary stored rows are safe: future versions raise MIGRATION_VERSION, a version below migration base raises MIGRATION_UNAVAILABLE, and malformed markers must retain read validation. Blindly dropping the plan would change errors, not just performance.

`c0b1719` established policy-bound operation isolation; `98c759d` composes policy scope into list/count. Preserve those effective predicates and the original caller-scope distinction. [0006](../0006-list-count-isolation/issue.md) studies occupancy separately; native count does not require weakening policy isolation or adding read snapshots.

## Example

Before and after for callers: `await api.items.count({ where: q => q.active.eq(true) })` returns the same number, subject to list permission; trusted count bypasses policy as before. There is no client/HTTP count endpoint.

Proposed internal contract:

```ts
type StorageCountOptions = Pick<StorageListOptions, 'where' | 'index'>;
// Added to StorageDriver:
count(resource: string, options?: StorageCountOptions,
      plan?: StorageListPlan): Promise<number>;
```

Before executor loops `storage.list('items', { limit: 200, ...options })`. After it calls `storage.count('items', options)` through the migrating/tracing/decorated driver. A plan requiring transformation safely scans; absence of a plan alone is not a runtime proof that dropping version checks is valid.

## Recommended ownership and eligibility

Storage owns count execution, shared SQL predicate/index range binding, and the scan algorithm when a read plan is supplied. Runtime supplies its migration plan/eligibility proof and preserves policy dispatch; it does not own pagination. Keep this within the existing packages: storage provides aggregate mechanics, runtime knows migration semantics.

For the first implementation retain the full plan unless the migrating decorator can prove every row that list would visit is current/read-valid in the same transaction. Design a lightweight version-validity signal into the aggregate, or a maintained validated-collection invariant. The aggregate may return internal guard flags plus the number, but the public StorageDriver result remains number. On a guard failure use the existing scan to reproduce migration/error semantics; do not invent a new error order. Absence of user migrations is insufficient evidence, including restored or rolled-back-version data. An arbitrary caller transform always forces scanning.

Preferred first step: an aggregate with a version guard over the same candidate population used by list, falling back before returning a result. This permits one SQLite aggregate and zero document pages for ordinary current-version collections without redundant transform work. Explicitly compare list's candidate selection for indexed versus unindexed queries: a guard over only final matches can miss errors list encounters before post-transform filtering. Verify malformed/missing/version marker interpretation against `readStoredVersion`; missing version may legitimately mean zero. If equivalent validation cannot be expressed cheaply, keep the scan and document reduced native eligibility rather than weaken semantics.

Use the existing SQL compiler for null/missing/scalars/string/in/ranges, index equality prefix, range, and residual predicates. No parallel dialect. Forward count through logged/traced, initialization, maintenance, migrating and transaction-scoped drivers; audit every StorageDriver implementation/test double. One count operation/span should enclose fallback without leaking a sequence of public storage list spans. Internal SQL diagnostics can still record scan work.

## Alternatives and tradeoffs

Moving the existing scan unchanged into storage is a safe staging point but does not fulfill this issue's performance outcome. Adding a runtime SQL escape hatch is rejected because it leaks SQL/schema ownership into orchestration. [Alternative B](./design-b.md) proves eligibility with a persisted invariant: simpler hot queries but more write/restore/layout obligations. The guarded aggregate keeps change closure around count, at the cost of SQL guard complexity. The exact efficient guard query remains a design validation item, not an implemented fact.

## Verification and migration

No public type or wire addition. Internal required method changes all decorators/test drivers together. Native trusted count observes one SQL snapshot instead of a series of independently queued pages; this strengthens observation but do not promise whole-count snapshots for the transformed trusted scan fallback. Nested `$transaction`/atomic action always joins the enclosing boundary.

Instrument SQL to assert one aggregate/no list pages for eligible indexed and unindexed counts. Compare with complete list traversal for metadata, null, missing, in, string operators, ranges and equality prefixes; include no migrations plus future/malformed versions, nonzero migration base with zero steps, old-schema transformations, uniqueness failures, and restored data. Compare which invalid nonmatching rows list visits before judging failure parity. Check scoped policy permission, trusted bypass, initialization/maintenance blocking, all decorators, and one count span. Remove countDocuments and its pagination dependency from executor. Run `vp check`, storage Node/Workers tests, runtime tests, and repository-wide gate after implementation.

This rethink read code/history, with no product changes or implementation tests. Native SQL guard expressibility/benefit is unmeasured; a small adapter-level query experiment on currentVersion/malformed markers is the next validation. Failure of that experiment selects B or narrower eligibility, not silent omission of migration errors.
