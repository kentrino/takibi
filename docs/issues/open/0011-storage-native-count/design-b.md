# Alternative: persisted validated-version eligibility

## Example

Caller before/after is still `await api.items.count({ where: q => q.active.eq(true) })`. Internally the migrating driver supplies a trusted eligibility marker to storage only after the collection's persisted state certifies all relevant rows current. Eligible calls become one COUNT aggregate; uncertified collections continue transformed scanning.

## Design and tradeoffs

Persist collection validation/version state and invalidate it for schema changes, restore/reset, direct/import writes, or any operation capable of adding unknown-version data. Update certification and documents atomically; restart/deployment must not trust an in-memory cache. A public or arbitrary decorator cannot assert this proof. Establish certification by bounded validation or while a complete migration/index backfill runs, then check and count in one serialized operation.

Compared with design A this simplifies aggregate SQL and supports zero-step nonzero-base collections once certified. It adds saved metadata, layout migration, and cross-cutting maintenance responsibilities just to accelerate count. Existing restored snapshots and old applications must default to uncertified. Select only if guard queries are too costly and benchmarks justify the invariant's maintenance burden. No separate package is justified.

Use design A's parity tests, plus crash/restart and invalidation tests for every writer and maintenance route. Inventory external/older-process writes before relying on certification: if any can bypass invalidation, this candidate is unsafe. This inventory and performance comparison are not completed; no implementation/test claim is made.
