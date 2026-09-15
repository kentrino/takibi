# Design B: Split partitions using the supported Durable Object backend

Partition data by independent business units such as marketplaces or regions from the outset, routing each to a separate DO through the current stub resolver. Preserve storage formats, StorageDriver, and the public backend API. Transactions across collections remain limited to one partition.

## Example

```ts
// Before: One application-selected global partition
stub: ({ context }) => context.env.DATA.getByName("marketplace");
// After: Illustrative routing by an authorized, resolved business unit
stub: ({ context, resolved }) => context.env.DATA.getByName(resolved.marketplaceId);
```

In this example, TInitial contains `{ env }` and the resolved context contains `{ marketplaceId }`. This does not introduce automatic tenantId inference. During migration, export/restore existing data by business unit, check references and ID collisions, and switch routing incrementally. A single transaction cannot guarantee inventory, balance, or uniqueness invariants across partitions; reject this option if the original workload requires those guarantees.

This avoids the remote adapter and distributed lease costs of A, but changes application data placement and destinations, making migration expensive. Measure the same read-heavy, independent-write, hot-record, and atomic workloads; record cross-partition invariant failures as incompatibilities rather than declaring them out of scope. This is attractive only if global atomicity is confirmed unnecessary and partitions distribute load sufficiently. Retain the original single-partition requirement and recommend A for now.
