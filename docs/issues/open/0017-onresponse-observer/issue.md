---
title: Expose an onResponse observer for completed public invocations
author: OpenAI Codex
cost: 5
priority: P1
priority_reason: "A concrete application otherwise duplicates post-response dispatch across many actions, and the generic lifecycle already provides isolated at-most-once notification."
category: observability
source_issue: 0063-onresponse-observer
---

# Configure completion observation for public invocations in one place

Applications currently duplicate notification dispatch across individual CRUD and action handlers. Connect a safe onResponse configuration to the existing lifecycle notification after settlement, awaiting one observation of success or failure for each single invocation and batch item. Completion requires withholding inputs and internal failures, preventing observer mutations and exceptions from changing the original response or commit, and reporting observer failure through one error log. Atomic auditing and delivery guarantees are out of scope.

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/context/types.ts`
- `packages/worker-runtime/src/adapter-map.ts`
- `packages/worker-runtime/src/invocation-adapters.ts`
- `packages/worker-runtime/src/invocation-response.ts`
- `packages/invocation-lifecycle/src/flow.ts`
