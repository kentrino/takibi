---
title: Let application routing own partition identity without reserving context.tenantId
author: OpenAI Codex
cost: 1
priority: P2
priority_reason: "The check contradicts the arbitrary-context API and complicates future transports, but it is an incomplete wiring guard rather than an independent security boundary."
category: architecture
source_issue: 0061-remove-context-tenantid-coupling
---

# Let application routing own partition identity without reserving context.tenantId

Named Durable Objects reject arbitrary serializable contexts unless `context.tenantId` equals the object name, contradicting the application-owned context contract. Remove that implicit check while leaving authentication and membership in application `resolve` and routing in `stub`, without a new partition field or wire format. Collection, action, and batch calls must work on named and unnamed objects without `tenantId`; existing exact-name routing must remain compatible, and documentation must explain the lost wiring-error check and the application routing obligations.

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/durable-object.ts`
- `packages/worker-runtime/src/context/executors.ts`
- `packages/worker-runtime/src/context/worker-call.ts`
- `packages/worker-runtime/tests/call-entrypoints.test.ts`
- `packages/takibi/README.md`
