# Local policy evaluation contract

## Decision and evidence

Resolved as documentation work; the following records the accepted design. The problem is a missing caller contract, not evidence that transaction isolation should be removed. No common cause warrants combining it with list/count isolation work in 0006.

`packages/policy/src/types.ts:24-50` exposes arbitrary application context and permits `Promise<AccessGrant>` without I/O or reentry guidance. `transactionBoundaryOf` in `packages/worker-runtime/src/invocation-plan-contract.ts:21` selects `full` for collections other than `add`. The [isolation decision](../../../spec/collection-operation-isolation.md) records the baseline, operation queue mechanism, and why authorization/revision/uniqueness checks share a boundary. These are still applicable; `add` is not evidence that all policy evaluation runs outside transactions because an enclosing atomic action can hold one.

`context/worker-call.ts:createCallResolveContext` awaits the resolver and checks JSON-safe context before dispatch; `context/executors.ts` then creates local execution or sends the wire request. This confirms the preparation point by reading the execution order. Atomic handlers and document guards/gates are not interchangeable with this point. Asynchronous schema validation remains another source of waiting even if policy were synchronous.

## Recommended design

If designed initially, policy would consume already-available decision inputs, while ingress resolves external identity and membership before storage execution. Use those existing boundaries: add matching guidance to `packages/takibi/README.md` and both policy type comments. No new package, API, or execution phase is needed.

Document that policy computes a grant from context, doc/nextDoc, and query without external HTTP or other awaited I/O; it must not await another root facade/storage operation or fetch/RPC back into the same DO. Local computation returning a Promise stays legal. These are obligations, not a promise of fail-fast detection. An external request can increase occupancy without a circular wait; root reentry can produce a circular wait.

Pre-resolved identity is a point-in-time input, not a frozen external-service snapshot. Immediate revocation, cross-row authorization, and external consistency require separate design; the example must not imply stronger guarantees. Do not move authorization outside its row/revision/uniqueness boundary.

## Example

The following are application-owned callback bodies; `loadMembership` verifies credentials and returns JSON-safe `{ canRead: boolean }`. `read` and `none` are grants from `takibi`.

```ts
// Before: accessPolicy awaits external work while storage may be locked.
const accessPolicy = async ({ userId }: { userId: string }) =>
  (await loadMembership(userId)).canRead ? read : none;

// After: use this resolve callback in createTakibi()({ resolve, stub }).
const resolve = async ({ request }: { request: Request }) => {
  const userId = await authenticate(request);
  const { canRead } = await loadMembership(userId);
  return { userId, canRead }; // Only serializable decision data crosses the wire.
};
const localAccessPolicy = async ({ canRead }: { canRead: boolean }) => (canRead ? read : none);
```

`authenticate` and `loadMembership` above are application helpers, not new Takibi APIs. Preserve the application's existing routing inputs in the returned context. Migration is to move external preparation into the existing resolver and consume its values locally; Promise signatures remain unchanged. For failed authentication, use the documented resolver error contract rather than granting access.

## Alternatives and verification

Doing nothing retains a reproducible queue hazard with no caller guidance. Removing Promise support breaks local asynchronous policies yet cannot prevent closure-based I/O or asynchronous validation. Runtime detection, cancellation/timeouts, or optimistic authorization retries require new rollback and consistency semantics; they do not belong in this documentation issue.

Verified here: relevant types, plan classification, resolution/serialization/dispatch order, and the existing isolation decision were read; no deadlocking process or product tests were run. During implementation, type-check the completed guide example against the public SDK, and verify that resolver completion precedes invocation and transaction entry. Keep existing isolation tests unchanged and passing. Whether external consumers require immediate revocation is unknown; if required, record a separate consistency requirement rather than presenting this example as sufficient.

## Original Scope

This issue covers contract documentation and usage examples. It does not remove Promise
support from the type, intercept arbitrary fetch calls, add reentry detection or timeouts,
or implement an optimistic retry protocol for external authorization. If runtime fail-fast
behavior becomes a product requirement, separately design the detectable paths and their
cancellation and rollback behavior.

## Original Acceptance criteria

- The README and `AccessPolicyFn/AccessContext` documentation agree on local evaluation,
  I/O, and reentry restrictions.
- Local policies returning Promises remain supported.
- Documented prohibitions are not confused with runtime detection guarantees.
- The external-information preparation example is verified against the implementation
  to execute before the transaction starts.
- Single-row authorization, revision, and uniqueness isolation is not weakened.
