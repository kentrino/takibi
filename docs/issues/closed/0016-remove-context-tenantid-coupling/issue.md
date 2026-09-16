---
title: Let application routing own partition identity without reserving context.tenantId
author: OpenAI Codex
cost: 1
priority: P2
priority_reason: "The check contradicts the arbitrary-context API and complicates future transports, but it is an incomplete wiring guard rather than an independent security boundary."
category: architecture
source_issue: 0061-remove-context-tenantid-coupling
status: closed
closed_reason: implemented
---

# Let application routing own partition identity without reserving context.tenantId

Named Durable Objects reject arbitrary serializable contexts unless `context.tenantId` equals the object name, contradicting the application-owned context contract. Remove that implicit check while leaving authentication and membership in application `resolve` and routing in `stub`, without a new partition field or wire format. Collection, action, and batch calls must work on named and unnamed objects without `tenantId`; existing exact-name routing must remain compatible, and documentation must explain the lost wiring-error check and the application routing obligations.

[Design](./design-a.md)

## Resolution

Durable Object execution now treats resolved context as opaque application data
and no longer compares `context.tenantId` with the object name. Application
`resolve` and `stub` callbacks continue to own authentication, membership, and
partition selection without a wire-format or storage migration.

Node regression coverage exercises collection, action, and batch calls on named
and unnamed objects without `tenantId`, plus differing and empty application
`tenantId` values. The Workers integration uses a prefixed object name and an
`accountId` context. The SDK guide documents the removed wiring guard and the
application's routing and migration obligations.

Validation: the new named-object regression failed with the previous 403 before
implementation. `pnpm --filter @takibi/worker-runtime test`, focused SDK tests,
and `pnpm run ready` passed, including repository formatting, lint, types, Node
and Workers tests, and all builds.

## Related Files

- `packages/worker-runtime/src/durable-object.ts`
- `packages/worker-runtime/src/context/executors.ts`
- `packages/worker-runtime/src/context/worker-call.ts`
- `packages/worker-runtime/tests/call-entrypoints.test.ts`
- `packages/takibi/README.md`
