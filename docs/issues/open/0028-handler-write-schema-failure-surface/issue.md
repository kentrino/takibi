---
title: Schema failures from writes inside action handlers reach clients as input validation
author: Cursor Agent
cost: 2
priority: P2
priority_reason: "A handler that builds an invalid document returns a client-facing 400 whose issue paths and messages come from the collection schema, which clients cannot tell apart from their own input errors."
category: correctness
---

# Schema failures from writes inside action handlers reach clients as input validation

Collection writes validate the document against the collection schema and
throw `SchemaValidationError` on failure (`typed-storage.ts` for add, set, and
update; reserved keys, empty ids, and `rev` checks also throw it).
`ActionHandler.run` does not catch errors from the handler, so when a write
made inside a handler fails this check, `normalizeInvocationFailureForServer`
turns it into `{ kind: "validation", code: "VALIDATION", status: 400, issues }`
for the action's caller.

As a result:

- The caller receives the same failure shape as an action input-schema
  failure, but each `path` is relative to the stored document of the
  collection being written, not to the action input.
- Issue messages and paths come from the collection schema, which the action
  caller never sent and may not know.
- When the handler itself built the invalid document, the failure is reported
  as a client error (400) rather than as a server failure.

Direct collection CRUD from the client is not affected: there the written
document is the request input, so document-relative paths match what the
client sent.

Completion means the behavior for a schema failure raised by a write inside an
action handler is chosen deliberately, documented, and covered by a test.

## Open Decisions

- Whether such failures stay `validation`, become an operation failure
  (client error or `INTERNAL`), or are left to the handler to catch and map.
- Whether the answer differs between policy-bound `collection` writes and
  trusted `$collection` writes.

## Related Files

- `packages/worker-runtime/src/typed-storage.ts` — write paths that throw `SchemaValidationError`
- `packages/worker-runtime/src/revision.ts` — `rev` check that throws `SchemaValidationError`
- `packages/worker-runtime/src/invocation-collaborators.ts` — `ActionHandler.run` passes handler errors through
- `packages/worker-runtime/src/context/runtime.ts` — `normalizeInvocationFailureForServer` maps `SchemaValidationError` to `validation`
- `packages/worker-runtime/src/result.ts` — `toTakibiFailure`
- `packages/takibi/README.md` — Actions section describes validation failures as input failures
- `docs/issues/open/0027-action-handler-validation-failure/issue.md` — handler-raised validation failures and their `path` base
