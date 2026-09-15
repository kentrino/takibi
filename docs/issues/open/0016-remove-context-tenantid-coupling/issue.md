---
title: Remove the implicit context.tenantId check from Durable Object execution
author: OpenAI Codex
cost: 1
priority: P2
priority_reason: "The check contradicts the arbitrary-context API and complicates future transports, but it is an incomplete wiring guard rather than an independent security boundary."
category: architecture
source_issue: 0061-remove-context-tenantid-coupling
---

# Problem

Takibi promises that resolved execution context is application-owned and reserves no `tenantId`,
`user`, or other property. The generated Durable Object nevertheless compares `state.id.name` with
`context.tenantId` for named objects and rejects a mismatch.

The check does not run for unnamed objects, and code with access to the internal binding can send a
self-consistent context. It therefore detects only some application wiring mistakes; it is not an
independent authentication or partition-isolation boundary. It also contradicts the public context
type and duplicates responsibilities already assigned to application `resolve` and `stub`.

# Proposal

Remove Durable Object name-to-context comparison and delete
`assertTenantMatchesDurableObjectName`.

- Application `resolve` owns authentication, membership checks, and partition-selection inputs.
- Application `stub` is the source of truth for routing to a Durable Object.
- Takibi does not interpret `tenantId` or any other application context property.
- Named Durable Objects remain recommended for stable application-defined partitions but are not
  required by the Takibi contract.
- Do not add a replacement partition field, resolver, or Worker-to-Durable-Object wire value.

This does not expose partition selection to public clients: the existing Worker route continues to
resolve the stub internally, and clients cannot choose a Durable Object binding or ID directly.

# Package boundaries

The change stays in `@takibi/worker-runtime`: Worker-call context resolution and stub routing remain
application integration points, while Durable Object invocation execution consumes opaque
serializable context. No API, protocol, storage, or query package should learn partition identity.

# Scope

In scope:

- removing implicit `context.tenantId` reads from collection, action, and batch execution;
- regression tests for named and unnamed Durable Objects with arbitrary serializable context;
- README clarification of application-owned partition routing.

Out of scope:

- changing `resolve` or `stub` signatures;
- requiring named objects;
- adding authentication providers, membership logic, or partition configuration;
- migrating existing applications that validly use `tenantId` with `idFromName`/`getByName`.

# Acceptance criteria

- Named and unnamed Durable Objects execute collection, action, and batch calls with serializable
  context that has no `tenantId`.
- Durable Object execution never reads `context.tenantId` and never returns `FORBIDDEN` solely for a
  name/context mismatch.
- Public clients still cannot bypass application `resolve` or `stub` to select storage partitions.
- Existing applications that route with `resolved.tenantId` require no migration.
- README assigns authentication/membership to `resolve` and partition routing to `stub`.
- `vp check`, worker-runtime Node/Workers tests, and the repository-wide gate pass.
