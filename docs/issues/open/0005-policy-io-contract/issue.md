---
title: Document safe local policy evaluation before transaction reentry becomes a circular wait
author: OpenAI Codex
cost: 2
priority: P1
priority_reason: "Policies now run inside full transaction boundaries, so undocumented I/O or reentry can deadlock a tenant operation."
category: documentation
---

# Document safe local policy evaluation before transaction reentry becomes a circular wait

Policies may return Promises, but awaiting external I/O can hold a transaction boundary and waiting for another operation on the same root driver can cause a circular wait. Document local evaluation and reentry obligations in the SDK guide and `AccessPolicyFn` / `AccessContext`, with a verified example preparing serializable decision inputs in `resolve` before dispatch. Completion requires preserving Promise support and existing authorization, revision, and uniqueness isolation, and distinguishing caller obligations from runtime detection and external-consistency guarantees.

[Design](./design-a.md)

## Related Files

- `packages/takibi/README.md`
- `packages/policy/src/types.ts`
- `packages/worker-runtime/src/context/worker-call.ts`
- `packages/worker-runtime/src/invocation-plan-contract.ts`
- `docs/spec/collection-operation-isolation.md`
