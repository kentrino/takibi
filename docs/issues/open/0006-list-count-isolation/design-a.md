# Retain the boundary while measuring its cost

## Decision and evidence

Keep this investigation open. `c0b1719` intentionally established operation isolation; it is not an accidental lock to remove. `48258b5` subsequently fixed vanished migration sources. The storage queue and executor confirm occupancy, but no workload measurement establishes a latency problem. The isolation spec records the existing contract.

Policy-bound `full` surrounds policy, scan, and persistence. Switching to `apply` only moves policy outside; it does not shorten the apply scan. Trusted root list runs queued chunks and trusted count traverses multiple list calls: neither should be described as the policy-bound whole-operation snapshot. A trusted `$transaction` and atomic action reuse the enclosing transaction; no proposed optimization may release it. Separate public list calls (`listAll` included) have no common snapshot merely because each page is isolated.

## Recommended investigation

First measure the existing implementation, then measure the safe native-count path in [0011](../0011-storage-native-count/issue.md) independently. An aggregate can reduce count work without weakening policy isolation. Vary document count, old-schema fraction, filter selectivity, indexed/unindexed access, and uniqueness checks. Record operation time, SQL rows scanned, migrated rows, waiting time for a set on another row/collection in the same DO, and peak memory. Record fixture, runtime, repetitions, and distribution; no latency or memory claim has been measured in this rethink.

The ideal design would offer explicit snapshot reads and separately controlled persistence. `StorageDriver` currently has no independent snapshot capability. Keep `full` unless measurements justify the additional machinery or an intentional public contract change. Record reconsideration thresholds from the measured workload, rather than inventing an SLA now.

Compare [bounded persistence](./design-b.md) against current `full` and against not persisting on list (persist only on get/write). The latter avoids write work but repeatedly migrates cold records, delays uniqueness failures, and still needs a response snapshot; it is not a free optimization.

## Verification and scope

Preserve post-transformation filtering, index order, keyset cursor binding, lookahead, uniqueness failures, and operation rollback. A row-level transaction alone supplies neither a page snapshot nor a whole-count snapshot. Fault injection must cover migration errors, uniqueness failures, updates/deletions during migration, and rejection without overwriting a newer revision. A rechecked current row must not silently be mixed into an older response snapshot.

Use concurrent operation tests and the existing atomic-action/migration tests to establish these contracts before benchmarking alternatives. This rethink inspected code/history; it did not run a benchmark or implementation tests. Producing measurements and a justified decision (including no change) closes this issue; any implementation following the decision is separate work.

## Example

Before and recommended initial outcome: `await api.items.count({ where: q => q.active.eq(true) })` retains its current policy-bound isolation. A simultaneous update to another row waits until that operation completes. Two calls to `api.items.list(...)` still need not observe the same point in time. No new option or weakened contract is proposed before measurement.
