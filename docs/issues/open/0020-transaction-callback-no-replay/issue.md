---
title: Specify and verify at-most-once transaction callback execution
author: OpenAI Codex
cost: 2
priority: P2
priority_reason: "The supported path does not intentionally replay handlers, but this safety contract is implicit and can be broken by storage wrappers or backend changes."
category: correctness
---

# Specify and verify at-most-once transaction callback execution

Atomic handlers and trusted transaction callbacks can perform external effects, but the storage interface leaves callback replay unspecified. Define and verify execution-count guarantees without changing the public API or current error behavior. Completion requires documentation and conformance tests for the SQLite backend and supported wrappers, including nested scopes, failures, unknown commit outcomes, and detection of a deliberately replaying test double. Distinguish this from client retry deduplication or exactly-once external delivery.

[Proposed RFC](../../../rfcs/0003-transaction-callback-no-replay.md)

## Related Files

- `packages/storage/src/types.ts`
- `packages/storage/src/storage.ts`
- `packages/worker-runtime/src/action-executor.ts`
- `packages/invocation-lifecycle/src/flow.ts`
- `packages/takibi/docs/spec/transactions.md`
- `packages/takibi/README.md`
- `packages/takibi/tests/atomic-actions.test.ts`
- `packages/takibi/tests/atomic-actions.workers.ts`
