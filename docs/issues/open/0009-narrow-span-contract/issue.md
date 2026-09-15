---
title: Define adapter obligations around the span values Takibi actually emits
author: OpenAI Codex
cost: 2
priority: P3
priority_reason: "The current union overstates adapter obligations but does not cause incorrect runtime behavior."
category: observability
source_issue: 0045-narrow-takibi-span-contract
---

# Define adapter obligations around the span values Takibi actually emits

The public span unions include producer/consumer kinds and unset/ok statuses that core does not emit, making adapter obligations broader than current core behavior. Align the contract and adapter mappings with internal/client/server kinds and failure-only status updates while preserving successful spans without explicit status. Completion requires type and adapter behavior coverage, unchanged package entry points, and an explicit compatibility decision for callers of the publicly returned tracer; external non-use must not be assumed.

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/tracing.ts`
- `packages/takibi/src/instrumentation.ts`
- `packages/opentelemetry/src/index.ts`
- `packages/opentelemetry/tests/index.test.ts`
- `packages/cloudflare-tracing/src/index.ts`
