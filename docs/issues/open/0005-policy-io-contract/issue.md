---
title: Document the accessPolicy contract for I/O and reentry
author: OpenAI Codex
cost: 2
priority: P1
priority_reason: "Policies now run inside full transaction boundaries, so undocumented I/O or reentry can deadlock a tenant operation."
category: documentation
---

# Problem

`AccessPolicyFn` permits Promises, and networking through context or closures is technically
possible, but the user-facing contract does not clearly state the restrictions when policy
runs inside a transaction. Policy-bound `set/update/delete/get/list/count` currently use
`full`, occupying Takibi's storage coordination queue while policy is awaited.

If policy waits for another operation on the same root driver, that operation waits for the
enclosing transaction to finish, producing a circular wait. External HTTP does not always
produce a circular wait, but adds its latency to the time the boundary is held. The absence
of a standard collections API in `AccessContext` does not prevent this usage.

See the [isolation spec](../../../spec/collection-operation-isolation.md) for evidence and
corrections to the original review.

# Proposal

Define the following usage contract in the user-facing README and policy type comments:

- Policy computes a grant from the supplied context, document, write candidate, query,
  and locally available decision inputs.
- Policy must not reenter the same DO through fetch/RPC or wait for another root
  facade/storage operation to complete.
- Policy must not await external HTTP or other I/O. Distinguish support for returning
  a Promise from the safety of arbitrary I/O.
- These are caller obligations, not a guarantee that the current runtime detects every
  violation and fails immediately.

Provide an example that performs authentication and retrieves external information before
entering the transaction, then passes the required values through context. Check the
existing context resolution path and execution order when writing the example. Atomic
action handlers and document action guards/gates can run inside the transaction, so do
not merely advise moving the work into a handler.

Briefly explain that previously resolved context does not freeze the current state of an
external service. Immediate revocation and authorization that depends on multiple pieces
of state require a separate consistency design. Schema validation can also await Promises;
making policy synchronous alone does not eliminate all waiting.

# Scope

This issue covers contract documentation and usage examples. It does not remove Promise
support from the type, intercept arbitrary fetch calls, add reentry detection or timeouts,
or implement an optimistic retry protocol for external authorization. If runtime fail-fast
behavior becomes a product requirement, separately design the detectable paths and their
cancellation and rollback behavior.

# Acceptance criteria

- The README and `AccessPolicyFn/AccessContext` documentation agree on local evaluation,
  I/O, and reentry restrictions.
- Local policies returning Promises remain supported.
- Documented prohibitions are not confused with runtime detection guarantees.
- The external-information preparation example is verified against the implementation
  to execute before the transaction starts.
- Single-row authorization, revision, and uniqueness isolation is not weakened.

# Priority

Address this contract gap without waiting for a performance incident. The documentation
could be included in the original PR; otherwise, track it here. It does not justify
reverting the original PR's single-row `full` boundaries.
