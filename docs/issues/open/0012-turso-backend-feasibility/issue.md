---
title: Measure whether a Turso backend can preserve Takibi semantics and improve scale
author: OpenAI Codex
cost: 8
priority: P3
priority_reason: "This is workload-specific discovery with no proven production path; correctness and operational issues in the supported Durable Object backend come first."
category: research
source_issue: 0056-turso-backend-feasibility
---

# Measure whether Turso can improve single-partition limits

Applications that place all data in one partition inherit the limits of one Durable Object, and there is no evidence yet that remote SQLite improves those limits while preserving semantics. Privately verify engine maturity, atomicity and uniqueness under contention, absence of callback replay, distributed initialization, and maintenance exclusion. Record performance for identical workloads and every promotion gate in a reproducible result.md. Unsupported, preview, and failing candidates are valid research outcomes; this issue does not change the public backend or production wiring.

[Design](./design-a.md)

## Related Files

- `packages/storage/src/types.ts`
- `packages/storage/src/storage.ts`
- `packages/snapshot/src/maintenance.ts`
- `packages/worker-runtime/src/context/backend.ts`
