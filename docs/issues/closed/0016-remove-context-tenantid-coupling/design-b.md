# Candidate B: make exact tenant names an explicit context contract

Keep the current runtime check and require `tenantId: string` for named-object execution, aligning resolver/stub documentation and types with that requirement. Document unnamed-object behavior explicitly. This favors compatibility with the current 403 guard over the existing arbitrary-context promise and would need revising that promise.

## Example

```ts
// Before: arbitrary application context is documented but fails for a named DO.
resolve: async ({ request }) => ({ accountId: await authorizedAccount(request) }),
// After: migrate the context and route to the same authorized exact-name partition.
resolve: async ({ request }) => ({ tenantId: await authorizedAccount(request) }),
stub: ({ context, resolved }) => context.env.STORE.getByName(resolved.tenantId),
```

These are existing createTakibi configuration callbacks with an application-owned authorization helper and typed namespace. Renaming context properties requires updating policies/actions; changing an existing DO name additionally requires an application storage migration and must not happen implicitly. The named-object guard still does not authenticate access to internal bindings.

This candidate preserves current mismatch tests and detects accidental name mismatches, but does not meet the original arbitrary-context and no-required-tenantId acceptance criteria. It is therefore not recommended; adopting it requires explicitly choosing a different product contract. Test required/mismatched/matching context for each invocation kind and keep unnamed behavior documented. See [A](./design-a.md) for current evidence and shared routing/security constraints. A replacement partition wire field or configurable verifier is deliberately not introduced.
