---
title: Reuse traced storage wrappers by driver identity
author: OpenAI Codex
cost: 2
priority: P3
priority_reason: "This removes small hot-path allocations without changing correctness or user-visible behavior."
category: performance
source_issue: 0044-cache-traced-storage-wrapper
---

# Problem

The in-process executor calls `tracedStorage(driver)` for each request when tracing is enabled, and
the generated Durable Object does the same for each `fetch`. `tracedStorage` currently creates a new
`StorageDriver` object with method closures on every call even though the underlying root driver is
stable for the executor or Durable Object lifetime.

The wrapper does not capture a tracer. Each operation resolves the active tracing context through
`withSpan`, so a wrapper for one driver can be reused across tracer registration, removal, and
replacement without retaining a stale provider.

# Proposal

Add a module-scoped `WeakMap<StorageDriver, StorageDriver>` in
`packages/worker-runtime/src/tracing.ts`. `tracedStorage(driver)` returns the cached wrapper for the
same driver identity and creates one only on a cache miss.

Apply the same rule to transaction-scoped drivers. The `transaction` method must call
`tracedStorage(scoped)` instead of a local uncached wrapping function. If the storage backend creates
a new scoped driver for each transaction, one allocation per distinct identity remains expected.

Keep per-request `resolveTracer` and the raw-versus-traced driver choice in
`context/executors.ts` and `durable-object.ts`. Requests without a tracer continue using the raw
driver. A `WeakMap` ensures the cache alone does not retain drivers after their owning executor or
Durable Object becomes unreachable.

# Scope

In scope:

- identity caching for root and transaction-scoped `StorageDriver` wrappers;
- regression coverage across tracer registration changes;
- unchanged in-process and Durable Object storage-span semantics.

Out of scope:

- span names, kinds, attributes, parentage, or error behavior;
- eliminating allocations when a backend always creates a new scoped driver;
- removing per-request tracer resolution;
- general storage optimization or allocation benchmarks.

# Acceptance criteria

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
