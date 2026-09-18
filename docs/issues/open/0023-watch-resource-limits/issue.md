---
title: Bound watch admission and snapshot delivery inside each Durable Object
author: OpenAI Codex
cost: 3
priority: P1
priority_reason: "Public watches can multiply query and delivery work without a library capacity limit; application middleware cannot own the generated object's live subscriptions."
category: security
---

# Bound watch admission and snapshot delivery inside each Durable Object

A client allowed to list can open many watches against one object, multiplying
queries on every commit; each snapshot is sent without a byte limit. Query row
limits and attachment limits do not bound this work. Provide finite, configurable
defaults for concurrent watches per object and UTF-8 bytes per snapshot, enforced
by the runtime that owns those resources.

Completion requires rejecting excess admissions before their initial query,
preventing concurrent upgrades from exceeding capacity, preserving the limit
across Hibernation and configuration changes, and never sending an oversized
snapshot. Failed upgrades and disconnected subscriptions must not leak capacity;
closing sockets must not permit unbounded admission. Delivery failures must
terminate only the affected subscription without changing committed writes or
bypassing list authorization. Verify these contracts with unit and native Workers
tests, and document defaults, compatibility, and the limits of this protection.

[Design](./design-a.md)

## Related Files

- `packages/worker-runtime/src/watch-runtime.ts` — admission, recovery, query and send ownership.
- `packages/worker-runtime/src/durable-object.ts` — generated runtime configuration and lifecycle.
- `packages/worker-runtime/src/context/types.ts` — public collection options.
- `packages/worker-runtime/src/context/application.ts` — passes options to the generated object.
- `packages/protocol/src/watch.ts` — existing attachments, error envelopes and close codes.
- `packages/worker-runtime/tests/watch-runtime.test.ts` — isolated runtime tests.
- `packages/worker-runtime/tests/watch.workers.ts` — native upgrade, policy and recovery tests.
- `packages/client/tests/watch.test.ts` — retry and terminal lifecycle contract.
- `packages/takibi/README.md` — public watch contract.
