# Opaque execution context and application-owned partition routing

## Decision and evidence

Keep 0016 open at P2 and remove the implicit comparison. The problem is within the runtime/context integration boundary; creating a partition abstraction or moving identity into protocol/storage packages increases separation cost without a new cohesive responsibility.

`packages/takibi/README.md:25-52` assigns credential verification, membership and partition choice to `resolve`, says no context keys are reserved, but then requires exact `tenantId` object names. Its Wrangler notes repeat the latter requirement. `packages/worker-runtime/src/durable-object.ts:fetch` checks `state.id.name` against context before the shared collection/action/batch dispatch. `assertTenantMatchesDurableObjectName` skips empty/unnamed IDs. `tests/call-entrypoints.test.ts` explicitly expects the named mismatch 403 today; removal changes tested behavior, not just prose.

`context/worker-call.ts` resolves and validates serializable context before dispatch. `context/executors.ts:createStubExecutor` invokes application `stub` with resolved data and encodes that same context onto the internal POST wire. The public caller does not get a binding or DO selector from this flow. The comparison cannot independently authenticate callers holding an internal binding, who can supply matching context, but it does catch a subset of accidental routing bugs. This useful guardrail is lost on removal.

History `df40b5a` wires DO execution through the common invocation contract; current placement covers batch and individual invocations. The inspected history does not establish a requirement for exact unprefixed names beyond the documented guard itself. Do not infer a new security guarantee or a historical reason from its existence.

## Candidate A: remove implicit name interpretation (recommended)

If designed from the application-owned-context requirement initially, the Worker authenticates and selects an allowed partition through `resolve`/`stub`, and the DO executes opaque serializable context. Delete the comparison and its helper; remove its now-unused state/import only where unused by the remaining runtime. Leave resolver/stub signatures, wire context, storage keys and invocation execution unchanged. Update both SDK guide occurrences together and retain the warning that the generated DO fetch is internal, not a public route.

Named DOs remain useful for stable application partitions but are not mandatory. Applications using `tenantId` may continue unchanged. Prefixes become legal for new partition naming, but changing an existing partition's name routes to a different object with different data; this change does not migrate persisted storage. Do not recommend renaming existing objects as part of adoption.

## Example

```ts
// Existing configuration: remains valid without migration.
resolve: async ({ request }) => ({ tenantId: await authorizedTenant(request) }),
stub: ({ context, resolved }) => context.env.STORE.getByName(resolved.tenantId),

// Newly supported configuration for an application using account partitions.
resolve: async ({ request }) => ({ accountId: await authorizedAccount(request) }),
stub: ({ context, resolved }) => context.env.STORE.getByName(`account:${resolved.accountId}`),
```

These are callback entries inside the existing typed `createTakibi<Initial>()({...})` configuration, with `Initial.env.STORE: DurableObjectNamespace`. Application helpers verify credentials and membership before returning the permitted ID. Before, the second configuration receives `FORBIDDEN` for a nonempty named DO because `tenantId` is absent; after, collection/action/batch execution proceeds to its normal policy and validation checks. Successful execution is not guaranteed if those checks reject the operation.

Applications depending on the old accidental-routing guard must validate their partition-selection function and test that `stub` routes authorized contexts to the expected object. No automatic replacement field or verifier is added. A new object naming scheme is an application storage migration, not a required API migration.

## Comparison and verification

[A is preferred; B retains and formalizes the exact-name contract](./design-b.md). A satisfies arbitrary context and makes dependency direction explicit with one small runtime change, but loses wiring diagnostics. B retains that diagnostic and current 403 behavior, yet forces an application property and transport naming scheme into execution context. A configurable routing verifier or new wire partition ID adds API/configuration cost and is excluded by the original requirements. Doing nothing leaves contradictory public contracts.

Verified here: actual rejection branch, wire construction, resolution order, current mismatch test, README contradiction, and invocation-refactor history were inspected. No product tests were run. Implement a Node/Workers matrix for named/unnamed objects, missing tenantId, differing tenantId and prefixed names, each across collection/action/batch; assert that normal policy denials and malformed-wire handling survive. Preserve exact-name applications and public resolver/stub execution tests. Search all runtime tenantId reads to ensure no implicit check remains; run `vp check`, worker-runtime Node/Workers tests and the repository gate.

Unknown: external applications may rely on the mismatch check as a wiring assertion. Confirm release notes and known consumers before release; if that compatibility promise is required, use B or defer removal explicitly. This does not justify claiming the current check is a complete security boundary.

## Original Scope

In scope:

- removing implicit `context.tenantId` reads from collection, action, and batch execution;
- regression tests for named and unnamed Durable Objects with arbitrary serializable context;
- README clarification of application-owned partition routing.

Out of scope:

- changing `resolve` or `stub` signatures;
- requiring named objects;
- adding authentication providers, membership logic, or partition configuration;
- migrating existing applications that validly use `tenantId` with `idFromName`/`getByName`.

## Original Acceptance criteria

- Named and unnamed Durable Objects execute collection, action, and batch calls with serializable
  context that has no `tenantId`.
- Durable Object execution never reads `context.tenantId` and never returns `FORBIDDEN` solely for a
  name/context mismatch.
- Public clients still cannot bypass application `resolve` or `stub` to select storage partitions.
- Existing applications that route with `resolved.tenantId` require no migration.
- README assigns authentication/membership to `resolve` and partition routing to `stub`.
- `vp check`, worker-runtime Node/Workers tests, and the repository-wide gate pass.
