# Takibi full-path macrobenchmark

This private workspace package exercises Takibi strictly through its stable
package entry points. It is not a publishable Takibi implementation package.

`full-path.bench.ts` runs one fresh, isolated multi-tenant issue-tracker
lifecycle per sample. It is a gross-regression macrobenchmark: handler
construction and validation/persistence of the fixed 216-document seed are
intentionally part of the score and can hide small layer-specific changes.

The measured path is:

```text
API builders -> client -> HTTP decode -> query/order compilation
-> policy -> schema validation -> executor/action executor
-> transaction/revision -> SQLite/indexes -> result encoding
```

The scenario also covers document, detached, and root actions; atomic
cross-collection writes; optimistic revisions; validation and policy failures;
fixed-size client read batching; and explicit public protocol round-trips.

Run it from `packages/takibi-bench`:

```sh
vp test benchmarks/full-path-scenario.test.ts
vp test bench benchmarks/full-path.bench.ts --no-file-parallelism --maxWorkers 1
```

Exclusions:

- JavaScript module import and cold-bundle startup are not measured because
  Vitest loads modules before sampling.
- A real network and the Cloudflare scheduler are not measured.
- The in-process backend does not traverse the Worker-to-Durable-Object stub.
  Explicit protocol round-trips cover codec cost, not RPC latency.
- Response serialization and public response validation are covered, but
  Takibi has no distinct public response encoder/decoder.
- Logical snapshot export/restore is outside this request-hot-path benchmark
  and needs a separate benchmark if it becomes a performance target.
- OpenTelemetry exporters are not enabled.
