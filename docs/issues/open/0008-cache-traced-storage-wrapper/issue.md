---
title: Reuse traced storage wrappers without capturing request tracing state
author: OpenAI Codex
cost: 2
priority: P3
priority_reason: "This removes small hot-path allocations without changing correctness or user-visible behavior."
category: performance
source_issue: 0044-cache-traced-storage-wrapper
---

# Reuse traced storage wrappers without capturing request tracing state

Tracing creates a new storage wrapper on every request and on each transaction callback, even when the underlying driver identity is unchanged. Reuse wrappers by driver identity while retaining request-local tracer selection, raw drivers for untraced requests, and existing storage span semantics. Completion requires root/scoped identity tests, tracer replacement and removal coverage, and weak cache ownership; the allocation reduction is known, but an end-to-end performance gain is not established.

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/tracing.ts`
- `packages/worker-runtime/src/context/executors.ts`
- `packages/worker-runtime/src/durable-object.ts`
- `packages/takibi/tests/tracing.test.ts`
