---
title: Specify and verify at-most-once transaction callback execution
author: OpenAI Codex
cost: 2
priority: P2
priority_reason: "The supported path does not intentionally replay handlers, but this safety contract is implicit and can be broken by storage wrappers or backend changes."
category: correctness
status: closed
closed_reason: implemented
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

## Resolution

Specified at-most-once execution for storage transactions, atomic handlers, and
trusted callbacks, including nested scopes and zero executions on admission
failure. Public APIs and error/settlement behavior are unchanged. Replaying drivers
are explicitly unsupported; retries and external effects are not deduplicated.

Shared conformance checks exercise local SQLite and Workers SQLite with migration,
tracing (with an active tracer), logging, and commit-observation decorators,
individually and composed. They check callback counts, return values,
error identity, nested failures, rollback, injected pre-commit failure, and a lost
commit acknowledgement with persisted writes. Trusted facade callbacks use the
same matrix. A deliberately replaying driver is detected by the count assertion.
Atomic handler counts and lifecycle unknown-outcome settlement have regression
coverage as well. The internal `afterInitialization` wrapper is exercised end to
end for success and handler failures by the Workers atomic-action tests; it is not
part of the full fault-injection matrix. RFC 0003 remains proposed because no
acceptance decision has been recorded.

No failing-before-fix test was needed because the implementation already conforms;
the negative replay test verifies the conformance check itself. Commit and unknown
outcome failures are simulated at the platform boundary, not induced platform
outages. Validation: `pnpm run ready` (format, lint, types, Node/Workers tests,
package builds).
